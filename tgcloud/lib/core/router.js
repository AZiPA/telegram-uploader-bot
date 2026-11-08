import {
  db, eq, bundles, adminSessions,
  tgApi, getEffectiveOwnerId, getRoleLevel,
  sendMsg, clearAdminSession, nowSec, getConfig,
  isValidBundleCode
} from '../helpers.js';
import { checkUserFlood } from '../middlewares/rate_limiter.js';
import { handleAdminCommand, handleAdminCallback, handleAdminPrompt } from '../admin/index.js';
import { handleProfilePrompt, handleProfilePhoto } from '../admin/profile.js';
import { renderHub, handleBundleCommand, handleBundleCallback, canManageBundle } from '../bundles/index.js';
import { executeDelivery, handleVoteAndRedownloadCallbacks } from '../filestore/delivery.js';
import { handleUploadCommand, handleMediaUpload } from '../filestore/upload.js';
import { handleForceJoinPrompt } from '../force_join/wizards.js';
import { handleChatMember } from '../force_join/handlers.js';
import { guardMessage, guardCallbackQuery } from '../middlewares/command_guard.js';
import { runOpportunisticMaintenance } from './background.js';
import { handleSqlRoute } from '../admin/sql_console.js';
import { t } from '../locales/index.js';
import { markUpdateDispatch, withUpdateLedger } from './update_ledger.js';
import { getDeliveryOperation } from '../filestore/delivery_state.js';

async function dispatchMessage(message, ctx, systemLangOrGuard) {
  if (!message?.from) return;
  const suppliedGuard = systemLangOrGuard && typeof systemLangOrGuard === 'object' && 'allowed' in systemLangOrGuard;
  // A guard can send a denial notification. Its dispatch boundary belongs to
  // the same durable Update as the domain handler it protects.
  if (!suppliedGuard) await markUpdateDispatch(ctx);
  const guard = suppliedGuard ? systemLangOrGuard
    : await guardMessage(message, ctx, typeof systemLangOrGuard === 'string' ? systemLangOrGuard : undefined);

  if (!guard.allowed) return;

  const { userId, chatId, lang, role, cmd, arg, isCommand, media } = guard;

  const flood = await checkUserFlood(userId, db);
  if (flood.limited) return;
  await markUpdateDispatch(ctx);

  if (ctx?.update?.my_chat_member) {
    await handleChatMember(ctx.update.my_chat_member, true).catch(() => {});
  }

  try {
    const text = (message.text || '').trim();
  const now = nowSec();

  // Check active admin session for prompt modes
  const activeAdminSession = await db.select().from(adminSessions).where(eq(adminSessions.admin_id, Number(userId))).get();
  const currentOwnerId = await getEffectiveOwnerId();
  const isOwner = (userId && currentOwnerId && Number(userId) === Number(currentOwnerId)) || role === 'owner';

  // SQLite Interactive Console & Terminal routing for bot owner
  const isSqlCmd = isCommand && (cmd === '/sql' || cmd === '/terminal' || cmd === '/console');
  const isSqlPrefix = text.startsWith('/sql') || text.startsWith('/terminal') || text.startsWith('/console');
  if (isSqlCmd || isSqlPrefix) {
    if (!isOwner) return; // Strict security: silently ignore non-owner
    if (!ctx.message) ctx.message = message;
    if (!ctx.from) ctx.from = message.from;
    if (!ctx.chat) ctx.chat = message.chat;
    if (!ctx.text) ctx.text = message.text;
    return await handleSqlRoute(ctx, db, tgApi, currentOwnerId);
  }

  if (isOwner && activeAdminSession?.mode === 'sql_terminal') {
    if (now - (activeAdminSession.updated_at || 0) > 600) {
      await clearAdminSession(userId, activeAdminSession);
    } else {
      if (!ctx.message) ctx.message = message;
      if (!ctx.from) ctx.from = message.from;
      if (!ctx.chat) ctx.chat = message.chat;
      if (!ctx.text) ctx.text = message.text;
      return await handleSqlRoute(ctx, db, tgApi, currentOwnerId);
    }
  }

  if (activeAdminSession) {
    const currentLevel = isOwner ? 4 : getRoleLevel(role);
    const isLevel3Mode = activeAdminSession.mode === 'add_admin' ||
      (typeof activeAdminSession.mode === 'string' && (activeAdminSession.mode.startsWith('profile_') || activeAdminSession.mode.startsWith('bprof_')));
    const reqLevel = isLevel3Mode ? 3 : 2;
    if (currentLevel < reqLevel) {
      await clearAdminSession(userId, activeAdminSession);
      return;
    }
  }
  const ADMIN_PROMPT_MODES = [
    'profile_name', 'profile_desc', 'profile_short_desc',
    'bprof_waiting_name', 'bprof_waiting_desc', 'bprof_waiting_short',
    'bprof_waiting_photo',
    'add_admin', 'fj_label', 'fj_renew_limit'
  ];
  const isAdminPrompt = activeAdminSession && ADMIN_PROMPT_MODES.includes(activeAdminSession.mode);

  // Command Breakout: Any message starting with "/" aborts pending prompt sessions
  if (isCommand || text.startsWith('/')) {
    if (isAdminPrompt) {
      await clearAdminSession(userId, activeAdminSession);
    }
  } else if (isAdminPrompt) {
    // Admin Session prompt handling (300s / 5-minute TTL)
    if (now - activeAdminSession.updated_at > 300) {
      await clearAdminSession(userId, activeAdminSession);
    } else if (activeAdminSession.mode === 'bprof_waiting_photo' || activeAdminSession.action === 'bprof_waiting_photo') {
      return await handleProfilePhoto(message, userId, chatId, lang, tgApi, db, activeAdminSession);
    } else if (text) {
      if (activeAdminSession.mode === 'fj_label' || activeAdminSession.mode === 'fj_renew_limit') {
        return await handleForceJoinPrompt(activeAdminSession, text, userId, chatId, lang);
      }
      if (activeAdminSession.mode && (activeAdminSession.mode.startsWith('profile_') || activeAdminSession.mode.startsWith('bprof_'))) {
        return await handleProfilePrompt(activeAdminSession, text, userId, chatId, lang);
      }
      return await handleAdminPrompt(activeAdminSession, text, userId, chatId, lang);
    }
  }

  if (isCommand) {
    if (cmd === '/setbotowner' || cmd === '/ermia' || cmd === '/transfer_ownership' || cmd === '/export_config' || cmd === '/import_config') {
      return await handleAdminCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
    }
    if (cmd === '/start') {
      if (!arg) return await sendMsg(chatId, t(lang, 'start_desc'));
      const code = arg;
      if (!isValidBundleCode(code)) {
        return await sendMsg(chatId, t(lang, 'file_not_found'));
      }
      if (role !== 'user') {
        const row = await db.select().from(bundles).where(eq(bundles.code, code)).get();
        if (row && (await canManageBundle(role, userId, row))) return await renderHub(chatId, code, lang);
      }
      return await executeDelivery(chatId, userId, code, lang, ctx, 0);
    }
    if (cmd === '/help') {
      return await sendMsg(chatId, t(lang, 'help_desc'));
    }

    const handledAdmin = await handleAdminCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
    if (handledAdmin) return;
    const handledUpload = await handleUploadCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
    if (handledUpload) return;
    return await handleBundleCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  }

  if (media) {
    return await handleMediaUpload(message, userId, chatId, lang, role, ctx);
  }
} finally {
  const maintPromise = runOpportunisticMaintenance(ctx).catch((err) => {
    console.error('[maintenance] Background run failed:', err);
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(maintPromise);
  }
  try {
    await maintPromise;
  } catch (_) {}
}
}

async function dispatchCallbackQuery(cq, ctx, systemLangOrGuard) {
  if (!cq?.from) return;

  const userId = cq.from.id, chatId = cq.message?.chat?.id, messageId = cq.message?.message_id;
  const data = cq.data || '';

  const suppliedGuard = systemLangOrGuard && typeof systemLangOrGuard === 'object' && 'allowed' in systemLangOrGuard;
  if (!suppliedGuard) await markUpdateDispatch(ctx);
  const guard = suppliedGuard ? systemLangOrGuard
    : await guardCallbackQuery(cq, ctx, typeof systemLangOrGuard === 'string' ? systemLangOrGuard : undefined);
  if (!guard.allowed) return;
  const { lang, role } = guard;
  const flood = await checkUserFlood(userId, db);
  if (flood.limited) {
    await markUpdateDispatch(ctx);
    cq._answered = true;
    await tgApi.answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});
    return;
  }
  await markUpdateDispatch(ctx);

  if (ctx?.update?.my_chat_member) {
    await handleChatMember(ctx.update.my_chat_member, true).catch(() => {});
  }

  try {
    const handledDl = await handleVoteAndRedownloadCallbacks(data, cq, userId, chatId, messageId, lang, ctx);
    if (handledDl) return;
    const handledBundle = await handleBundleCallback(data, cq, userId, chatId, messageId, lang, ctx);
    if (handledBundle) return;
    return await handleAdminCallback(data, cq, userId, chatId, messageId, lang, role, ctx);
  } finally {
    if (!cq._answered) {
      await tgApi.answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});
    }
    const maintPromise = runOpportunisticMaintenance(ctx).catch((err) => {
      console.error('[maintenance] Background run failed:', err);
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(maintPromise);
    }
    try {
      await maintPromise;
    } catch (_) {}
  }
}

async function recoverDeliveryUpdate(ctx, operationId) {
  const payload = ctx?.update?.callback_query || ctx?.update?.message;
  const userId = payload?.from?.id, chatId = payload?.message?.chat?.id ?? payload?.chat?.id;
  if (!userId || !chatId) throw new Error('Delivery recovery identity unavailable');
  const op = await getDeliveryOperation(operationId, userId, chatId);
  if (!op) throw new Error('Delivery recovery access denied');
  const flood = await checkUserFlood(userId, db);
  if (flood.limited) { ctx.router_recovery_deferred = true; return; }
  const lang = (await getConfig('language', 'en')) || 'en';
  await markUpdateDispatch(ctx);
  try {
    return await executeDelivery(chatId, userId, op.bundle_code, lang, ctx, 0, op.admin_test_id || null, op.id);
  } finally {
    await runOpportunisticMaintenance(ctx).catch((err) => {
      console.error('[maintenance] Recovery run failed:', err);
    });
  }
}

export async function handleMessage(message, ctx = {}, systemLangOrGuard) {
  if (!message?.from) return;
  ctx.update ||= {};
  ctx.update.message ||= message;
  return await withUpdateLedger(ctx, (ownedCtx) => dispatchMessage(message, ownedCtx, systemLangOrGuard), recoverDeliveryUpdate);
}

export async function handleCallbackQuery(cq, ctx = {}, systemLangOrGuard) {
  if (!cq?.from) return;
  ctx.update ||= {};
  ctx.update.callback_query ||= cq;
  return await withUpdateLedger(ctx, (ownedCtx) => dispatchCallbackQuery(cq, ownedCtx, systemLangOrGuard), recoverDeliveryUpdate);
}

export const routeMessage = handleMessage;
export const routeCallback = handleCallbackQuery;

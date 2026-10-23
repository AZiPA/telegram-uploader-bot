import {
  db, eq, bundles, adminSessions, userSessions,
  tgApi, escapeHtml, getEffectiveOwnerId, getUserRole, getRoleLevel,
  sendLogAlert, sendMsg, clearAdminSession, clearUserSession, nowSec, getConfig,
  isValidBundleCode
} from '../helpers.js';
import {
  verifyBundlePin, grantBundleAccess, recordPinFailure
} from '../filestore/unlock.js';
import { checkUserFlood, checkPinLockout } from '../middlewares/rate_limiter.js';
import { handleAdminCommand, handleAdminCallback, handleAdminPrompt } from '../admin/index.js';
import { handleProfilePrompt, handleProfilePhoto } from '../admin/profile.js';
import { renderHub, handleBundleCommand, handleBundleCallback, handleBundlePassPrompt, canManageBundle } from '../bundles/index.js';
import { executeDelivery, handleVoteAndRedownloadCallbacks } from '../filestore/delivery.js';
import { handleUploadCommand, handleMediaUpload } from '../filestore/upload.js';
import { handleForceJoinPrompt } from '../force_join/wizards.js';
import { handleChatMember } from '../force_join/handlers.js';
import { guardMessage, getRequiredCallbackLevel } from '../middlewares/command_guard.js';
import { runOpportunisticMaintenance } from './background.js';
import { handleSqlRoute } from '../admin/sql_console.js';
import { t } from '../locales/index.js';

const seenUpdates = new Set();

export async function handleMessage(message, ctx, systemLangOrGuard) {
  if (!message?.from) return;
  const updId = ctx?.update?.update_id;
  if (updId) {
    if (seenUpdates.has(updId)) return;
    seenUpdates.add(updId);
    if (seenUpdates.size > 2000) seenUpdates.delete(seenUpdates.keys().next().value);
  }

  const guard = (systemLangOrGuard && typeof systemLangOrGuard === 'object' && 'allowed' in systemLangOrGuard)
    ? systemLangOrGuard
    : await guardMessage(message, ctx, typeof systemLangOrGuard === 'string' ? systemLangOrGuard : undefined);

  if (!guard.allowed) return;

  const { userId, chatId, lang, role, cmd, arg, isCommand, media } = guard;

  if (ctx?.update?.chat_member || ctx?.update?.my_chat_member) {
    await handleChatMember(ctx.update.chat_member || ctx.update.my_chat_member).catch(() => {});
  }

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(runOpportunisticMaintenance(ctx));
  } else {
    runOpportunisticMaintenance(ctx).catch((err) => {
      console.error('[maintenance] Background run failed:', err);
    });
  }

  const text = (message.text || '').trim();
  const now = nowSec();

  // Check active user session (e.g. bundle passcode unlock)
  const activeUserSession = await db.select().from(userSessions).where(eq(userSessions.user_id, Number(userId))).get();

  // Check active admin session for prompt modes
  const activeAdminSession = await db.select().from(adminSessions).where(eq(adminSessions.admin_id, Number(userId))).get();
  const currentOwnerId = await getEffectiveOwnerId();
  const isOwner = (userId && currentOwnerId && Number(userId) === Number(currentOwnerId)) || role === 'owner';

  const isPrivileged = isOwner || getRoleLevel(role) >= 2;
  if (!isPrivileged) {
    const flood = await checkUserFlood(userId, db);
    if (flood.limited) return;
  }

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
      await clearAdminSession(userId);
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
      await clearAdminSession(userId);
      return;
    }
  }
  const ADMIN_PROMPT_MODES = [
    'profile_name', 'profile_desc', 'profile_short_desc',
    'bprof_waiting_name', 'bprof_waiting_desc', 'bprof_waiting_short',
    'bprof_waiting_photo',
    'add_admin', 'fj_label', 'fj_renew_limit', 'bundle_set_pass'
  ];
  const isAdminPrompt = activeAdminSession && ADMIN_PROMPT_MODES.includes(activeAdminSession.mode);

  // Command Breakout: Any message starting with "/" aborts pending prompt sessions
  if (isCommand || text.startsWith('/')) {
    if (activeUserSession && activeUserSession.mode === 'unlock_pass') {
      await clearUserSession(userId);
    }
    if (isAdminPrompt) {
      await clearAdminSession(userId);
    }
  } else {
    // 1. User Session prompt handling (unlock_pass)
    if (activeUserSession && activeUserSession.mode === 'unlock_pass') {
      // 180s (3-minute) TTL for user prompt sessions
      const sessionUpdatedAt = activeUserSession.updated_at ?? activeUserSession.updatedAt ?? 0;
      if (now - sessionUpdatedAt > 180) {
        await clearUserSession(userId);
      } else if (text) {
        const bundleCode = activeUserSession.code;
        const row = await db.select().from(bundles).where(eq(bundles.code, bundleCode)).get();
        if (!row || !row.passcode_hash) {
          await clearUserSession(userId);
          if (!row) return sendMsg(chatId, t(lang, 'file_not_found'));
          return executeDelivery(chatId, userId, bundleCode, lang, ctx);
        }

        const pinLock = await checkPinLockout(userId, db);
        if (pinLock.locked) {
          await clearUserSession(userId);
          return sendMsg(chatId, t(lang, 'passcode_locked_out'));
        }

        const isValid = await verifyBundlePin(row, text);
        if (isValid) {
          await grantBundleAccess(userId, row.code);
          return executeDelivery(chatId, userId, bundleCode, lang, ctx, 0, text);
        } else {
          const sessionAttempts = (activeUserSession.attempts || 0) + 1;
          const { isLockedOut } = await recordPinFailure(userId, sessionAttempts);
          if (isLockedOut) {
            await sendLogAlert(`🚨 <b>Brute-force Alert:</b> User <code>${escapeHtml(userId)}</code> locked out on bundle <code>${escapeHtml(row.code)}</code>.`);
            return sendMsg(chatId, t(lang, 'passcode_locked_out'));
          } else {
            await db.update(userSessions).set({ attempts: sessionAttempts, updated_at: now }).where(eq(userSessions.user_id, Number(userId))).run();
            return sendMsg(chatId, t(lang, 'passcode_wrong'));
          }
        }
      }
    } else if (isAdminPrompt) {
      // 2. Admin Session prompt handling (300s / 5-minute TTL)
      if (now - activeAdminSession.updated_at > 300) {
        await clearAdminSession(userId);
      } else if (activeAdminSession.mode === 'bprof_waiting_photo' || activeAdminSession.action === 'bprof_waiting_photo') {
        return await handleProfilePhoto(message, userId, chatId, lang, tgApi, db);
      } else if (text) {
        if (activeAdminSession.mode === 'bundle_set_pass') {
          return await handleBundlePassPrompt(activeAdminSession, text, userId, chatId, lang);
        }
        if (activeAdminSession.mode === 'fj_label' || activeAdminSession.mode === 'fj_renew_limit') {
          return await handleForceJoinPrompt(activeAdminSession, text, userId, chatId, lang);
        }
        if (activeAdminSession.mode && (activeAdminSession.mode.startsWith('profile_') || activeAdminSession.mode.startsWith('bprof_'))) {
          return await handleProfilePrompt(activeAdminSession, text, userId, chatId, lang);
        }
        return await handleAdminPrompt(activeAdminSession, text, userId, chatId, lang);
      }
    }
  }

  if (isCommand) {
    if (cmd === '/setbotowner' || cmd === '/ermia') {
      return await handleAdminCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
    }
    if (cmd === '/start') {
      if (!arg) return sendMsg(chatId, t(lang, 'start_desc'));
      let code = arg;
      let pin = undefined;
      const pinMatch = /^([0-9a-zA-Z]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})_([A-Za-z0-9-]{1,32})$/.exec(arg);
      if (pinMatch) {
        code = pinMatch[1];
        pin = pinMatch[2];
      }
      if (!isValidBundleCode(code)) {
        return sendMsg(chatId, t(lang, 'file_not_found'));
      }
      if (role !== 'user' && !pin) {
        const row = await db.select().from(bundles).where(eq(bundles.code, code)).get();
        if (row && (await canManageBundle(role, userId, row))) return renderHub(chatId, code, lang);
      }
      return executeDelivery(chatId, userId, code, lang, ctx, 0, pin);
    }
    if (cmd === '/help') {
      return sendMsg(chatId, t(lang, 'help_desc'));
    }

    const handledAdmin = await handleAdminCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
    if (handledAdmin) return;
    const handledUpload = await handleUploadCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
    if (handledUpload) return;
    return handleBundleCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  }

  if (media) {
    return handleMediaUpload(message, userId, chatId, lang, role, ctx);
  }
}

export async function handleCallbackQuery(cq, ctx, systemLangOrGuard) {
  if (!cq?.from) return;
  const updId = ctx?.update?.update_id;
  if (updId) {
    if (seenUpdates.has(updId)) return;
    seenUpdates.add(updId);
    if (seenUpdates.size > 2000) seenUpdates.delete(seenUpdates.keys().next().value);
  }

  const userId = cq.from.id, chatId = cq.message?.chat?.id, messageId = cq.message?.message_id;
  const data = cq.data || '';

  const guard = (systemLangOrGuard && typeof systemLangOrGuard === 'object' && 'allowed' in systemLangOrGuard)
    ? systemLangOrGuard
    : null;

  let lang, role;
  if (guard) {
    lang = guard.lang;
    role = guard.role;
  } else {
    lang = (typeof systemLangOrGuard === 'string' ? systemLangOrGuard : null) || (await getConfig('language')) || 'en';
    role = await getUserRole(userId);
    const currentOwnerId = await getEffectiveOwnerId();
    const isOwner = (userId && currentOwnerId && Number(userId) === Number(currentOwnerId)) || role === 'owner';
    const userLevel = isOwner ? 4 : getRoleLevel(role);

    const requiredLevel = getRequiredCallbackLevel(data);
    if (userLevel < requiredLevel) {
      cq._answered = true;
      return await tgApi.answerCallbackQuery({
        callback_query_id: cq.id,
        text: t(lang, 'superadmin_only_command').replace(/<[^>]+>/g, ''),
        show_alert: true,
      }).catch(() => {});
    }
  }

  if (ctx?.update?.chat_member || ctx?.update?.my_chat_member) {
    await handleChatMember(ctx.update.chat_member || ctx.update.my_chat_member).catch(() => {});
  }

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(runOpportunisticMaintenance(ctx));
  } else {
    runOpportunisticMaintenance(ctx).catch((err) => {
      console.error('[maintenance] Background run failed:', err);
    });
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
  }
}

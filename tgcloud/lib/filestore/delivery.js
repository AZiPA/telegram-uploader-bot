import {
  db, eq, and, sql, bundles, bundleVotes, tgApi, getConfig,
  getUserRole, getRoleLevel, strikeMap, ACTIONS, LIMITS,
  sendMsg, answerCq, getBundle, parseItems, nowSec,
} from '../helpers.js';
import * as storage from '../services/storage_channel.js';
import { logRateLimitHit } from '../services/log_channel.js';
import { buildDeliveryKeyboard } from '../shared/buttons.js';
import { buildForceJoinUserKeyboard } from '../force_join/panel.js';
import { checkUserMembership } from '../force_join/service.js';
import { handleVoteCallback } from './voting.js';
import { checkUserBan } from './unlock.js';
import { t } from '../locales/index.js';
import { isPremiumEmojiEnabled, applyEmojis } from '../shared/emojis.js';
import { resolveAdminTestOperation, adminTestCallback, parseAdminTestCallback } from './trusted_admin_test.js';
import { deleteBundle } from '../bundles/lifecycle.js';
import { bundleMutationGuard } from '../bundles/permissions.js';
import {
  deliveryRequestKey, findDeliveryRequest, getDeliveryOperation, findAdminDelivery,
  createDeliveryOperation, initializeDeliveryAttempt, acquireDeliveryAttempt, releaseDeliveryAttempt,
  currentDeliveryBundle, currentDeliveryItem, deliveryReceipts, startDeliveryDispatch,
  confirmDeliveryItem, recordDeliveryOutcome, skipDeliveryItem, projectDeliveryDeletionQueue,
  setDeliveryTerminal, deliveryCallback, parseDeliveryCallback, readDeliveryAttempt, recoverDeliveryTerminal,
} from './delivery_state.js';
import { reserveDeliveryQuota, claimOneTime, settleDeliveryAttempt } from './delivery_accounting.js';
import { linkUpdateOperation, markUpdateDispatch } from '../core/update_ledger.js';

function progress(op, receipts) {
  const byId = new Map(receipts.map((receipt) => [receipt.item_id, receipt]));
  const snapshot = parseItems(op.items);
  const confirmed = receipts.filter((receipt) => receipt.state === 'confirmed').length;
  const unknown = receipts.filter((receipt) => ['dispatching', 'unknown'].includes(receipt.state)).length;
  const next = snapshot.findIndex((item) => !['confirmed', 'skipped'].includes(byId.get(item.item_id)?.state));
  return { byId, confirmed, unknown, next: next < 0 ? snapshot.length : next, snapshot };
}

async function settle(op, bundle, terminal = false, owner = null) {
  const state = progress(op, await deliveryReceipts(op.attempt_id));
  await settleDeliveryAttempt(await readDeliveryAttempt(op.attempt_id), bundle, { confirmed: state.confirmed, unknown: state.unknown, terminal, owner });
  await projectDeliveryDeletionQueue(op);
  return state;
}

async function stopUnavailableOperation(op) {
  const attempt = await initializeDeliveryAttempt(op);
  if (await recoverDeliveryTerminal(op, attempt)) return;
  const owner = await acquireDeliveryAttempt(op);
  if (!owner) return;
  try {
    const evidence = await settle(op, null, true, owner);
    await setDeliveryTerminal(op, evidence.unknown ? 'unknown' : 'failed', owner);
  } finally { await releaseDeliveryAttempt(op, owner); }
}

export async function executeDelivery(chatId, userId, code, lang, ctx = {}, offset = 0, adminTestOperationId = null, deliveryOperationId = null) {
  const isPremium = await isPremiumEmojiEnabled(db);
  const say = (key) => sendMsg(chatId, applyEmojis(t(lang, key), isPremium));
  if (!Number.isInteger(offset) || offset < 0 || offset >= 25) return say('file_not_found');
  let trusted = null;
  if (adminTestOperationId !== null && adminTestOperationId !== false) {
    trusted = await resolveAdminTestOperation(adminTestOperationId, userId, chatId, code);
    if (!trusted) return say('bundle_access_denied');
    code = trusted.bundle_code;
  }
  const role = await getUserRole(userId), isStaff = getRoleLevel(role) >= 2;
  if (await checkUserBan(userId, chatId, lang)) return;
  if (!isStaff && !trusted && await getConfig('maintenance_mode', '0') === '1') return say('maintenance_alert');

  const requestKey = deliveryRequestKey(ctx, userId, chatId, trusted?.operation_id || '');
  let op = deliveryOperationId ? await getDeliveryOperation(deliveryOperationId, userId, chatId)
    : offset > 0 && trusted ? await findAdminDelivery(trusted.operation_id, userId, chatId)
      : await findDeliveryRequest(requestKey, userId, chatId);
  if ((deliveryOperationId || offset > 0) && !op) return say('bundle_access_denied');
  if (op && (op.expires_at <= nowSec() || op.admin_test_id !== (trusted?.operation_id || ''))) return say('bundle_access_denied');
  if (op) await linkUpdateOperation(ctx, 'delivery', op.id);

  let row = op ? await currentDeliveryBundle(op)
    : trusted ? await db.select().from(bundles).where(and(eq(bundles.upload_session_id, trusted.bundle_id), bundleMutationGuard(userId))).get()
      : await getBundle(code);
  if (op && ['complete', 'failed', 'unknown', 'pruned'].includes(op.state)) {
    if (op.state !== 'pruned') await settle(op, row, op.state !== 'unknown');
    if (op.state === 'complete' && row?.is_one_time && !trusted) await deleteBundle(row);
    return;
  }
  if (!row) {
    if (op) await stopUnavailableOperation(op);
    return say('file_not_found');
  }
  if (row.expires_at > 0 && nowSec() >= row.expires_at) {
    if (op) await stopUnavailableOperation(op);
    return say('bundle_expired');
  }
  if (trusted && !await db.select({ code: bundles.code }).from(bundles).where(and(
    eq(bundles.upload_session_id, trusted.bundle_id), bundleMutationGuard(userId),
  )).get()) return say('bundle_access_denied');

  if (!isStaff && !trusted) {
    const fj = await checkUserMembership(userId, lang, Boolean(op || offset));
    if (!fj.ok) {
      const verifyBtn = await getConfig('fj_verify_btn_text', '');
      return sendMsg(chatId, applyEmojis(`<b>${t(lang, 'force_join_title')}</b>\n\n${t(lang, 'force_join_desc')}`, isPremium),
        buildForceJoinUserKeyboard(lang, fj.unjoinedChannels, row.code, verifyBtn));
    }
  }
  if (!parseItems(row.items).length) return say('file_not_found');
  if (!op) op = await createDeliveryOperation(row, userId, chatId, requestKey, trusted?.operation_id || '');
  if (!op) return say('file_not_found');
  ctx.delivery_operation_id = op.id;
  ctx.delivery_attempt_id = op.attempt_id;
  await linkUpdateOperation(ctx, 'delivery', op.id);
  const attempt = await initializeDeliveryAttempt(op);
  if (await recoverDeliveryTerminal(op, attempt)) {
    await settle(op, row, attempt.state !== 'unknown');
    if (attempt.state === 'complete' && row.is_one_time && !trusted) await deleteBundle(row);
    return;
  }
  const owner = await acquireDeliveryAttempt(op);
  if (!owner) return;

  let resultState, rateLimited = false, retryAfter = 0, sentThisPage = 0;
  try {
    const previous = progress(op, await deliveryReceipts(op.attempt_id));
    if (previous.unknown) {
      await settle(op, row);
      await setDeliveryTerminal(op, 'unknown', owner);
      return;
    }
    if (offset > previous.next) return say('bundle_access_denied');
    const quota = await reserveDeliveryQuota(attempt, trusted ? 'owner' : role);
    if (!quota.allowed) {
      await setDeliveryTerminal(op, 'failed', owner);
      return say(quota.reason === 'link' ? 'limit_link' : 'limit_daily');
    }
    const claim = await claimOneTime(quota.attempt || attempt, row, Boolean(trusted));
    if (!claim.allowed) {
      await settle(op, row, true, owner);
      await setDeliveryTerminal(op, 'failed', owner);
      return say('bundle_already_used');
    }
    await settle(op, row);
    const autoDelete = Math.max(0, Number(await getConfig('auto_delete_seconds', '0')) || 0);
    const end = Math.min(previous.snapshot.length, offset + LIMITS.CHUNK_DELIVERY_SIZE);
    for (let index = offset; index < end; index++) {
      const item = previous.snapshot[index];
      const receipts = progress(op, await deliveryReceipts(op.attempt_id));
      const receipt = receipts.byId.get(item.item_id);
      if (['confirmed', 'skipped'].includes(receipt?.state)) continue;
      if (['unknown', 'dispatching'].includes(receipt?.state)) break;
      row = await currentDeliveryBundle(op);
      if (!row) break;
      if (trusted && !await db.select({ code: bundles.code }).from(bundles).where(and(
        eq(bundles.upload_session_id, op.bundle_id), bundleMutationGuard(userId),
      )).get()) break;
      if (!currentDeliveryItem(row, item)) { await skipDeliveryItem(op, item); continue; }

      // Legacy adapters are conservative until per-method lifecycle hooks apply.
      if (!storage.DELIVERY_LIFECYCLE_HOOKS) {
        await markUpdateDispatch(ctx, true);
        ctx.content_dispatch_started = true;
        await startDeliveryDispatch(op, owner, item, 'primary', '', Boolean(row.protect_content));
      }
      let confirmed = false, outcome = null;
      const result = await storage.deliverMediaItems(chatId, [item], tgApi, {
        storageChannelId: await storage.getStorageChannelId(db), protect: Boolean(row.protect_content),
        bundleCode: row.code, bundleId: op.bundle_id, db, isPremium, lang,
        async beforeDispatch(_item, stage, method) {
          await markUpdateDispatch(ctx, true);
          ctx.content_dispatch_started = true;
          await startDeliveryDispatch(op, owner, item, stage, method, Boolean(row.protect_content));
        },
        async onConfirmed(_item, messageId) {
          await confirmDeliveryItem(op, item, messageId, autoDelete);
          confirmed = true;
        },
        async onOutcome(_item, value) {
          outcome = value;
          await recordDeliveryOutcome(op, item, value);
        },
      });
      if (!confirmed && result?.sentIds?.length === 1 && Number.isSafeInteger(result.sentIds[0]) && result.sentIds[0] > 0) {
        await confirmDeliveryItem(op, item, result.sentIds[0], autoDelete);
        confirmed = true;
      }
      if (confirmed) {
        sentThisPage++;
        await settle(op, row);
        continue;
      }
      rateLimited = Boolean(result?.rateLimited);
      retryAfter = Number(result?.retryAfter) || 60;
      if (!outcome) await recordDeliveryOutcome(op, item, { kind: rateLimited ? 'rate_limited' : 'unknown', retryAfter });
      break;
    }
    resultState = progress(op, await deliveryReceipts(op.attempt_id));
    const allDone = resultState.next === resultState.snapshot.length;
    const definitiveFailure = !allDone && !rateLimited && !resultState.unknown && resultState.next < end;
    await settle(op, row, allDone || definitiveFailure, owner);
    if (resultState.unknown) await setDeliveryTerminal(op, 'unknown', owner);
    else if (allDone) {
      await setDeliveryTerminal(op, 'complete', owner);
      if (row?.is_one_time && !trusted) await deleteBundle(row);
    } else if (definitiveFailure) await setDeliveryTerminal(op, 'failed', owner);
  } catch (error) {
    for (const receipt of await deliveryReceipts(op.attempt_id)) {
      if (receipt.state === 'dispatching') await recordDeliveryOutcome(op, { item_id: receipt.item_id }, { kind: 'unknown' });
    }
    await settle(op, row).catch(() => {});
    throw error;
  } finally {
    await releaseDeliveryAttempt(op, owner);
  }

  // Receipts, queue entries, quota and claims precede all fallible UI work.
  if (!resultState || resultState.unknown) return;
  if (rateLimited) {
    await logRateLimitHit(chatId, retryAfter, tgApi, db).catch(() => {});
    await sendMsg(chatId, applyEmojis(t(lang, 'rate_limit_temp', { min: Math.max(1, Math.ceil(retryAfter / 60)) }), isPremium)).catch(() => {});
  }
  const nextOffset = resultState.next, remainingCount = resultState.snapshot.length - nextOffset;
  const adminTestCallbacks = trusted ? {
    next: remainingCount ? adminTestCallback(op.id, nextOffset) : undefined,
    restart: `dl:r:t:${op.id}`,
  } : undefined;
  if (remainingCount) {
    const kb = buildDeliveryKeyboard(lang, row?.code || code, { nextOffset, remainingCount, isPremium, adminTestCallbacks,
      continuationData: deliveryCallback(op.id, nextOffset) });
    const info = t(lang, 'delivery_part_info', { part: Math.ceil(nextOffset / LIMITS.CHUNK_DELIVERY_SIZE), total: Math.ceil(resultState.snapshot.length / LIMITS.CHUNK_DELIVERY_SIZE) });
    await sendMsg(chatId, applyEmojis(sentThisPage ? t(lang, 'delivery_files_count', { count: sentThisPage }) + info : t(lang, 'delivery_failed'), isPremium), kb).catch(() => {});
  } else {
    const votes = await db.select({ likes: sql`COUNT(CASE WHEN vote_type = 'like' THEN 1 END)`,
      dislikes: sql`COUNT(CASE WHEN vote_type = 'dislike' THEN 1 END)` }).from(bundleVotes).where(eq(bundleVotes.code, row?.code || code)).get().catch(() => null);
    const kb = buildDeliveryKeyboard(lang, row?.code || code, { likes: votes?.likes || 0, dislikes: votes?.dislikes || 0, isPremium, adminTestCallbacks });
    await sendMsg(chatId, applyEmojis(t(lang, 'delivered_title'), isPremium), kb).catch(() => {});
  }
}

export async function handleDeliveryCallback(data, cq, userId, chatId, messageId, lang, ctx = {}) {
  if (data.startsWith(ACTIONS.VOTE_LIKE) || data.startsWith(ACTIONS.VOTE_DISLIKE)) return handleVoteCallback(data, cq, userId, chatId, messageId, lang);
  if (!ctx.update?.callback_query) ctx = { ...ctx, update: { ...ctx.update, callback_query: { ...cq, data,
    message: cq.message || { message_id: messageId, chat: { id: chatId } } } } };
  if (data.startsWith('dl:r:t:')) {
    await answerCq(cq);
    const op = await getDeliveryOperation(data.slice(7), userId, chatId);
    const trusted = op?.admin_test_id && await resolveAdminTestOperation(op.admin_test_id, userId, chatId);
    if (!trusted) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    return executeDelivery(chatId, userId, trusted.bundle_code, lang, ctx, 0, trusted.operation_id);
  }
  if (data.startsWith(ACTIONS.REDOWNLOAD)) {
    await answerCq(cq);
    return executeDelivery(chatId, userId, data.slice(ACTIONS.REDOWNLOAD.length), lang, ctx);
  }
  if (data.startsWith('dl:p:o:')) {
    await answerCq(cq);
    const token = parseDeliveryCallback(data);
    if (!token) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    const op = await getDeliveryOperation(token.id, userId, chatId);
    if (!op) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    return executeDelivery(chatId, userId, op.bundle_code, lang, ctx, token.offset, null, op.id);
  }
  if (data.startsWith('dl:p:t:')) {
    await answerCq(cq);
    const token = parseAdminTestCallback(data);
    const op = token && await getDeliveryOperation(token.operationId, userId, chatId);
    const trusted = token && await resolveAdminTestOperation(op?.admin_test_id || token.operationId, userId, chatId);
    if (!trusted) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    return executeDelivery(chatId, userId, trusted.bundle_code, lang, ctx, token.offset, trusted.operation_id, op?.id || null);
  }
  if (data.startsWith(ACTIONS.FORCE_JOIN_CHECK)) {
    const code = data.slice(ACTIONS.FORCE_JOIN_CHECK.length), now = Date.now();
    if (now - (strikeMap.get(`fj:${userId}`) || 0) < (LIMITS.FORCE_JOIN_THROTTLE_SEC || 3) * 1000) {
      return answerCq(cq, t(lang, 'fj_wait_cooldown', { sec: LIMITS.FORCE_JOIN_THROTTLE_SEC }), true);
    }
    strikeMap.set(`fj:${userId}`, now);
    const fj = await checkUserMembership(userId, lang, false);
    if (!fj.ok) return answerCq(cq, t(lang, 'fj_not_joined_alert'), true);
    await answerCq(cq, t(lang, 'fj_verified_alert'));
    return executeDelivery(chatId, userId, code, lang, ctx);
  }
  if (data.startsWith(ACTIONS.CHUNK_DELIVERY)) {
    await answerCq(cq);
    return sendMsg(chatId, t(lang, 'bundle_access_denied'));
  }
}

export const handleVoteAndRedownloadCallbacks = handleDeliveryCallback;
export { deliverMediaItems } from '../services/storage_channel.js';

import {
  db, eq, and, or, sql,
  userDownloads, bundles, bundleVotes, deletionQueue,
  tgApi, getConfig, escapeHtml,
  getUserRole, getRoleLevel, strikeMap, ACTIONS, LIMITS,
  sendMsg, answerCq, getBundle, parseItems, nowSec
} from '../helpers.js';
import { checkDownloadQuota, consumeDownloadQuota } from '../middlewares/rate_limiter.js';
import { deliverMediaItems, getStorageChannelId } from '../services/storage_channel.js';
import { sendLogAlert, logRateLimitHit, logMissingStorageItems } from '../services/log_channel.js';
import { buildDeliveryKeyboard } from '../shared/buttons.js';
import { buildForceJoinUserKeyboard } from '../force_join/panel.js';
import { checkUserMembership } from '../force_join/service.js';
import { handleVoteCallback } from './voting.js';
import { checkUserBan } from './unlock.js';
import { t } from '../locales/index.js';
import { isPremiumEmojiEnabled, applyEmojis } from '../shared/emojis.js';

export async function executeDelivery(chatId, userId, code, lang, ctx, offset = 0, isAdminTest = false) {
  const isPremium = await isPremiumEmojiEnabled(db);
  const role = await getUserRole(userId);
  const isStaff = getRoleLevel(role) >= 2;
  const today = new Date().toISOString().slice(0, 10);

  if (!isStaff && !isAdminTest) {
    if ((await getConfig('maintenance_mode', '0')) === '1') {
      return sendMsg(chatId, applyEmojis(t(lang, 'maintenance_alert'), isPremium));
    }
    const banCheck = await checkUserBan(userId, chatId, lang);
    if (banCheck) return;
  }

  const row = await getBundle(code);
  if (!row) return sendMsg(chatId, applyEmojis(t(lang, 'file_not_found'), isPremium));

  const now = nowSec();
  if (row.expires_at > 0 && now >= row.expires_at) {
    return sendMsg(chatId, applyEmojis(t(lang, 'bundle_expired'), isPremium));
  }

  if (!isStaff && !isAdminTest) {
    const fj = await checkUserMembership(userId);
    if (!fj.ok) {
      const verifyBtn = await getConfig('fj_verify_btn_text', '');
      const kb = buildForceJoinUserKeyboard(lang, fj.unjoinedChannels, code, verifyBtn);
      return sendMsg(chatId, applyEmojis(`<b>${t(lang, 'force_join_title')}</b>\n\n${t(lang, 'force_join_desc')}`, isPremium), kb);
    }
  }

  const items = parseItems(row.items);
  if (!items.length) return sendMsg(chatId, applyEmojis(t(lang, 'file_not_found'), isPremium));

  if (offset < 0 || offset >= items.length || offset % LIMITS.CHUNK_DELIVERY_SIZE !== 0) {
    return sendMsg(chatId, applyEmojis(t(lang, 'file_not_found'), isPremium));
  }

  const isNonVipUser = !isStaff && role !== 'vip' && !isAdminTest;
  let fileDl = null;
  if (isNonVipUser) {
    const fileLimit = Number(await getConfig('file_daily_limit', LIMITS.DEFAULT_FILE_DAILY_LIMIT));
    fileDl = await db.select({ download_count: userDownloads.download_count })
      .from(userDownloads)
      .where(and(eq(userDownloads.user_id, userId), eq(userDownloads.code, code), eq(userDownloads.access_date, today)))
      .get();
    const quotaCheck = await checkDownloadQuota(userId, role, db);

    if (offset === 0) {
      if (fileDl && fileLimit > 0 && fileDl.download_count >= fileLimit) return sendMsg(chatId, applyEmojis(t(lang, 'limit_link'), isPremium));
      if (!quotaCheck.allowed) return sendMsg(chatId, applyEmojis(t(lang, 'limit_daily'), isPremium));
    } else {
      const hasStartedToday = Boolean(fileDl && fileDl.download_count > 0);
      const withinFileLimit = fileLimit === 0 || (fileDl && fileDl.download_count <= fileLimit);
      if (!hasStartedToday || !withinFileLimit) {
        return sendMsg(chatId, applyEmojis(t(lang, 'limit_daily'), isPremium));
      }
    }
  }

  if (row.is_one_time && !isAdminTest) {
    if (offset === 0) {
      const claimRes = await db.update(bundles)
        .set({
          consumed_by: userId,
          expires_at: sql`CASE WHEN expires_at > 0 AND expires_at < ${now + 900} THEN expires_at ELSE ${now + 900} END`,
        })
        .where(and(
          eq(bundles.code, row.code),
          or(eq(bundles.consumed_by, 0), eq(bundles.consumed_by, userId))
        ))
        .run();
      const affected = claimRes?.rowsAffected ?? 0;
      if (affected !== 1) {
        return sendMsg(chatId, applyEmojis(t(lang, 'bundle_already_used'), isPremium));
      }
    } else {
      if (row.consumed_by !== userId) {
        return sendMsg(chatId, applyEmojis(t(lang, 'bundle_already_used'), isPremium));
      }
    }
  }

  const chunk = items.slice(offset, offset + LIMITS.CHUNK_DELIVERY_SIZE);
  const protect = Boolean(row.protect_content);
  const storageChannelId = await getStorageChannelId(db);

  let sentIds = [];
  let deliveredCount = 0;

  const deliveryResult = await deliverMediaItems(chatId, chunk, tgApi, {
    storageChannelId,
    protect,
    bundleCode: code,
    db,
    isPremium,
    lang,
  });

  if (deliveryResult?.pruned) {
    return;
  }

  sentIds = deliveryResult.sentIds || [];
  deliveredCount = deliveryResult.deliveredCount || sentIds.length;

  if (deliveryResult.rateLimited) {
    const retrySec = deliveryResult.retryAfter || 60;
    await logRateLimitHit(chatId, retrySec, tgApi, db);
    const min = Math.max(1, Math.ceil(retrySec / 60));
    await sendMsg(chatId, applyEmojis(t(lang, 'rate_limit_temp', { min }), isPremium));
    if (deliveredCount === 0) {
      if (row.is_one_time && !isAdminTest && offset === 0) {
        await db.update(bundles)
          .set({
            consumed_by: 0,
            expires_at: row.expires_at || 0,
          })
          .where(and(eq(bundles.code, row.code), eq(bundles.consumed_by, userId)))
          .run();
      }
      return;
    }
  }

  if (deliveredCount === 0) {
    if (row.is_one_time && !isAdminTest && offset === 0) {
      await db.update(bundles)
        .set({
          consumed_by: 0,
          expires_at: row.expires_at || 0,
        })
        .where(and(eq(bundles.code, row.code), eq(bundles.consumed_by, userId)))
        .run();
    }
    return sendMsg(chatId, applyEmojis(t(lang, 'delivery_failed'), isPremium));
  }

  if (isNonVipUser && offset === 0 && deliveredCount > 0) {
    if (fileDl) {
      await db.update(userDownloads)
        .set({ download_count: sql`download_count + 1` })
        .where(and(eq(userDownloads.user_id, userId), eq(userDownloads.code, code), eq(userDownloads.access_date, today)))
        .run();
    } else {
      await db.insert(userDownloads).values({
        user_id: userId,
        code,
        access_date: today,
        download_count: 1,
      }).run();
    }
    await consumeDownloadQuota(userId, db);
  }

  const autoDel = Number(await getConfig('auto_delete_seconds', '0'));
  if (autoDel > 0 && sentIds.length > 0) {
    await db.insert(deletionQueue).values({
      chat_id: chatId,
      message_ids: JSON.stringify(sentIds),
      delete_at: now + autoDel,
    }).run();
  }

  const nextOffset = offset + deliveredCount;
  const remainingCount = Math.max(0, items.length - nextOffset);
  if (nextOffset < items.length) {
    const partInfo = t(lang, 'delivery_part_info', { part: Math.ceil(nextOffset / LIMITS.CHUNK_DELIVERY_SIZE), total: Math.ceil(items.length / LIMITS.CHUNK_DELIVERY_SIZE) });
    const kb = buildDeliveryKeyboard(lang, code, { nextOffset, remainingCount, isPremium });
    await sendMsg(chatId, applyEmojis(`${t(lang, 'delivery_files_count', { count: deliveredCount })}${partInfo}`, isPremium), kb);
  } else {
    let kbOpts = { likes: 0, dislikes: 0, isPremium };
    if (row.is_one_time && !isAdminTest && !deliveryResult.rateLimited) {
      await db.delete(bundleVotes).where(eq(bundleVotes.code, code)).run();
      await db.delete(bundles).where(eq(bundles.code, code)).run();
    } else {
      const votes = await db.select({
        likes: sql`COUNT(CASE WHEN vote_type = 'like' THEN 1 END)`,
        dislikes: sql`COUNT(CASE WHEN vote_type = 'dislike' THEN 1 END)`,
      }).from(bundleVotes).where(eq(bundleVotes.code, code)).get();
      kbOpts = { likes: votes?.likes || 0, dislikes: votes?.dislikes || 0, isPremium };
    }
    const kb = buildDeliveryKeyboard(lang, code, kbOpts);
    await sendMsg(chatId, applyEmojis(t(lang, 'delivered_title'), isPremium), kb);
  }
}

export async function handleDeliveryCallback(data, cq, userId, chatId, messageId, lang, ctx) {
  if (data.startsWith(ACTIONS.VOTE_LIKE) || data.startsWith(ACTIONS.VOTE_DISLIKE)) {
    return handleVoteCallback(data, cq, userId, chatId, messageId, lang);
  }

  if (data.startsWith(ACTIONS.CHUNK_DELIVERY) || data.startsWith(ACTIONS.REDOWNLOAD)) {
    const throttleKey = `dl_cb:${userId}`;
    const last = strikeMap.get(throttleKey) || 0;
    const now = Date.now();
    if (now - last < 1500) {
      return answerCq(cq);
    }
    strikeMap.set(throttleKey, now);
  }

  if (data.startsWith(ACTIONS.REDOWNLOAD)) {
    const code = data.slice(ACTIONS.REDOWNLOAD.length);
    await answerCq(cq);
    return executeDelivery(chatId, userId, code, lang, ctx, 0);
  }

  if (data.startsWith(ACTIONS.FORCE_JOIN_CHECK)) {
    const code = data.slice(ACTIONS.FORCE_JOIN_CHECK.length);
    const now = Date.now();
    const last = strikeMap.get(`fj:${userId}`) || 0;
    if (now - last < (LIMITS.FORCE_JOIN_THROTTLE_SEC || 3) * 1000) {
      return answerCq(cq, t(lang, 'fj_wait_cooldown', { sec: LIMITS.FORCE_JOIN_THROTTLE_SEC }), true);
    }
    strikeMap.set(`fj:${userId}`, now);
    const fj = await checkUserMembership(userId);
    if (!fj.ok) {
      return answerCq(cq, t(lang, 'fj_not_joined_alert'), true);
    }
    await answerCq(cq, t(lang, 'fj_verified_alert'));
    return executeDelivery(chatId, userId, code, lang, ctx, 0);
  }

  if (data.startsWith(ACTIONS.CHUNK_DELIVERY)) {
    const parts = data.slice(ACTIONS.CHUNK_DELIVERY.length).split(':');
    await answerCq(cq);
    return executeDelivery(chatId, userId, parts[0], lang, ctx, Number(parts[1]) || 0);
  }
}

export const handleVoteAndRedownloadCallbacks = handleDeliveryCallback;
export { deliverMediaItems } from '../services/storage_channel.js';

import { api } from 'sdk';
import {
  db as defaultDb, eq, systemConfig, getConfig, setConfig,
  tgApi as defaultTgApi, escapeHtml, bundles, bundleVotes, sendMsg
} from '../helpers.js';
import { logMissingStorageItems, sendLogAlert } from './log_channel.js';
import { t } from '../locales/index.js';
import { applyEmojis } from '../shared/emojis.js';

function detectActualMediaType(errorDesc) {
  if (!errorDesc || typeof errorDesc !== 'string') return null;
  const SUPPORTED = ['photo', 'document', 'video', 'audio', 'voice', 'video_note', 'animation', 'sticker'];

  const m1 = errorDesc.match(/can\x27t use ([a-z_]+) with (?:send)?([a-z_]+)/i);
  if (m1 && SUPPORTED.includes(m1[1].toLowerCase())) {
    return m1[1].toLowerCase();
  }

  const m2 = errorDesc.match(/expected ([a-z_]+),? (?:got|found) ([a-z_]+)/i);
  if (m2 && SUPPORTED.includes(m2[2].toLowerCase())) {
    return m2[2].toLowerCase();
  }

  const m3 = errorDesc.match(/(?:type mismatch|file of type|wrong type)[^a-z_]*([a-z_]+)/i);
  if (m3 && SUPPORTED.includes(m3[1].toLowerCase())) {
    return m3[1].toLowerCase();
  }

  return null;
}

/**
 * Check if storage channel mirroring is active.
 *
 * @param {object} [db]
 * @returns {Promise<Boolean>}
 */
export async function isStorageChannelActive(db = defaultDb) {
  const active = await getConfig('storage_channel_active', 'false');
  return active === 'true';
}

/**
 * Read storage_channel_id from systemConfig (cached or queried).
 * Returns null if not configured or disabled.
 *
 * @param {object} [db]
 * @returns {Promise<string|null>}
 */
export async function getStorageChannelId(db = defaultDb) {
  const val = await getConfig('storage_channel_id', null);
  if (!val) return null;
  const trimmed = typeof val === 'string' ? val.trim() : String(val).trim();
  if (!trimmed || ['off', '0', 'clear', 'disable', 'none'].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

/**
 * Verify storage channel rights:
 * - Check if bot is administrator/creator
 * - Verify can_post_messages permission
 * - Check has_protected_content !== true
 * - Perform a live silent send-and-delete test message to verify actual posting rights
 *
 * @param {string|number} channelId
 * @param {object} [tgApi]
 * @returns {Promise<{ ok: boolean, reason?: string, error?: any }>}
 */
export async function verifyStorageChannel(channelId, tgApi = defaultTgApi) {
  try {
    const me = await tgApi.getMe({});
    const chat = await tgApi.getChat({ chat_id: channelId });
    if (chat?.has_protected_content === true) {
      return { ok: false, reason: 'protected', error: new Error('Channel has protected content') };
    }

    const member = await tgApi.getChatMember({ chat_id: channelId, user_id: me.id });
    if (member?.status !== 'administrator' && member?.status !== 'creator') {
      return { ok: false, reason: 'not_admin', error: new Error('Bot is not administrator or creator') };
    }
    if (member?.status === 'administrator' && !member?.can_post_messages) {
      return { ok: false, reason: 'cannot_post', error: new Error('Bot lacks can_post_messages permission') };
    }

    const testMsg = await tgApi.sendMessage({
      chat_id: channelId,
      text: '🔄 Storage verification test',
      disable_notification: true,
    });

    if (testMsg?.message_id) {
      try {
        await tgApi.deleteMessage({
          chat_id: channelId,
          message_id: testMsg.message_id,
        });
      } catch (_) {}
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'access_error', error: err };
  }
}

/**
 * Register a storage channel:
 * - Requires userLevel === 4 (owner only).
 * - Probes bot membership with api.getChatMember (can_post_messages: true).
 * - Checks api.getChat for has_protected_content !== true.
 * - Sends a silent test message and deletes it immediately.
 * - On success: sets storage_channel_id and storage_channel_active = 'true'.
 *
 * @param {string|number} channelId
 * @param {number} userLevel
 * @param {object} [tgApi]
 * @returns {Promise<{ ok: boolean, reason?: string, error?: any }>}
 */
export async function registerStorageChannel(channelId, userLevel = 0, tgApi = defaultTgApi) {
  if (userLevel !== 4) {
    return { ok: false, reason: 'owner_only', error: new Error('Owner only') };
  }

  const check = await verifyStorageChannel(channelId, tgApi);
  if (!check.ok) {
    return check;
  }

  const cleanId = String(channelId).trim();
  await setConfig('storage_channel_id', cleanId);
  await setConfig('storage_channel_active', 'true');
  return { ok: true, channelId: cleanId };
}

/**
 * Copy media to storage channel:
 * - If storageChannelId is configured, copy the message via tgApi.copyMessage and return { message_id, channel_id }.
 * - On runtime copy errors (403 or 400), automatically trips the circuit-breaker (storage_channel_active = 'false').
 *
 * @param {object} msg
 * @param {object} media
 * @param {string} mediaType
 * @param {string|null} storageChannelId
 * @param {object} [tgApi]
 * @returns {Promise<{ message_id: number, channel_id: string }|null>}
 */
export async function copyMediaToStorage(msg, media, mediaType, storageChannelId, tgApi = defaultTgApi) {
  if (!storageChannelId || ['off', '0', 'clear', 'disable', 'none'].includes(String(storageChannelId).trim().toLowerCase())) {
    return null;
  }

  const fromChatId = msg?.chat?.id || msg?.chat_id;
  const messageId = msg?.message_id;
  if (!fromChatId || !messageId) {
    throw new Error('Invalid message for copyMediaToStorage');
  }

  try {
    const copyRes = await tgApi.copyMessage({
      chat_id: storageChannelId,
      from_chat_id: fromChatId,
      message_id: messageId,
    });

    if (copyRes?.message_id) {
      return { message_id: copyRes.message_id, channel_id: String(storageChannelId) };
    }
    throw new Error('No message_id in copyMessage response');
  } catch (err) {
    const status = Number(err?.code || err?.status || 0);
    const desc = String(err?.description || err?.message || '');
    const isChannelFatal =
      status === 403 ||
      (status === 400 && (
        desc.includes('CHAT_ADMIN_REQUIRED') ||
        desc.includes('CHAT_FORWARDS_RESTRICTED') ||
        desc.toLowerCase().includes('kicked') ||
        desc.toLowerCase().includes('chat not found')
      ));
    if (isChannelFatal) {
      await setConfig('storage_channel_active', 'false');
    }
    throw err;
  }
}

/**
 * Deliver media items implementing 3-Stage Fallback Delivery:
 * - Stage 1 (Primary): Deliver using file_id.
 * - Stage 2 (Fallback on Error): If file_id delivery throws Bot API 400 (FILE_REFERENCE_EXPIRED, invalid file id):
 *   - Check if item has storage_message_id AND storage_channel_active === 'true'.
 *   - If NO backup available: delete bundle from bundles & bundle_votes, inform user, return pruned.
 *   - If backup exists: attempt copyMessages from storage channel.
 *     - If copy fails: prune bundle from DB and inform user.
 *     - If copy succeeds: Scenario C (type mismatch self-healing) - update bundle's items in DB with true media type.
 *
 * @param {string|number} chatId
 * @param {Array<object>} items
 * @param {object} [tgApi]
 * @param {object} [options]
 * @returns {Promise<{ sentIds: Array<number>, deliveredCount: number, rateLimited: boolean, retryAfter?: number, pruned?: boolean }>}
 */
export async function deliverMediaItems(chatId, items, tgApi = defaultTgApi, options = {}) {
  const protect = Boolean(options.protect || options.protect_content);
  const isPremium = Boolean(options.isPremium);
  const lang = options.lang || 'en';
  const bundleCode = options.bundleCode || null;
  const db = options.db || defaultDb;

  const storageActive = (await getConfig('storage_channel_active', 'false')) === 'true';
  const rawStorage = options.storageChannelId !== undefined ? options.storageChannelId : (storageActive ? await getStorageChannelId(db) : null);
  const storageChannelId = (storageActive && rawStorage && !['off', '0', 'clear', 'disable', 'none'].includes(String(rawStorage).trim().toLowerCase()))
    ? String(rawStorage).trim()
    : null;

  const getItemStorageId = (it) => (it.storage_message_id != null ? it.storage_message_id : (it.post_message_id != null ? it.post_message_id : null));

  let sentIds = [];
  let deliveredCount = 0;

  for (const item of items) {
    let sentMessageId = null;
    let fileIdError = null;

    // Stage 1 (Primary): Deliver using file_id
    if (item.file_id) {
      try {
        const sendOpts = { chat_id: chatId, protect_content: protect };
        if (item.caption && ['photo', 'document', 'video', 'audio', 'voice', 'animation'].includes(item.type)) {
          sendOpts.caption = escapeHtml(String(item.caption).slice(0, 1024));
          sendOpts.parse_mode = 'HTML';
        }

        const callTg = (method, params) => {
          if (tgApi && typeof tgApi[method] === 'function') {
            return tgApi[method](params);
          }
          if (typeof api[method] === 'function') {
            return api[method](params);
          }
          throw new Error(`Method ${method} not found on tgApi or api`);
        };

        let res;
        if (item.type === 'photo') {
          res = await callTg('sendPhoto', { ...sendOpts, photo: item.file_id });
        } else if (item.type === 'video') {
          res = await callTg('sendVideo', { ...sendOpts, video: item.file_id });
        } else if (item.type === 'audio') {
          res = await callTg('sendAudio', { ...sendOpts, audio: item.file_id });
        } else if (item.type === 'voice') {
          res = await callTg('sendVoice', { ...sendOpts, voice: item.file_id });
        } else if (item.type === 'video_note') {
          res = await callTg('sendVideoNote', { chat_id: chatId, protect_content: protect, video_note: item.file_id });
        } else if (item.type === 'animation') {
          res = await callTg('sendAnimation', { ...sendOpts, animation: item.file_id });
        } else if (item.type === 'sticker') {
          res = await callTg('sendSticker', { chat_id: chatId, protect_content: protect, sticker: item.file_id });
        } else {
          res = await callTg('sendDocument', { ...sendOpts, document: item.file_id });
        }

        sentMessageId = res?.message_id || null;
      } catch (err) {
        const is429 = err?.code === 429 || err?.status === 429 || Boolean(err?.parameters?.retry_after);
        if (is429) {
          const retryAfter = Number(err?.parameters?.retry_after) || 60;
          return { sentIds, deliveredCount, rateLimited: true, retryAfter, pruned: false };
        }
        fileIdError = err;
      }
    } else {
      fileIdError = new Error('No file_id');
      fileIdError.code = 400;
    }

    if (sentMessageId) {
      sentIds.push(sentMessageId);
      deliveredCount++;
      continue;
    }

    // Stage 2 (Fallback on Error):
    const errCode = Number(fileIdError?.code || fileIdError?.status || 0);
    const errDesc = String(fileIdError?.description || fileIdError?.message || '');
    const isDeadFileId = fileIdError?.message === 'No file_id' ||
      /wrong (?:remote )?file identifier|file reference expired|FILE_REFERENCE_EXPIRED|invalid file/i.test(errDesc);
    if (!isDeadFileId) {
      console.error('Item send failed (not a dead file_id); bundle left untouched:', errCode, errDesc);
      break;
    }

    const itemStorageId = getItemStorageId(item);
    const targetChannelId = item.storage_channel_id || storageChannelId;
    const hasBackup = Boolean(storageActive && targetChannelId && itemStorageId != null);

    if (!hasBackup) {
      const bCode = bundleCode ? escapeHtml(bundleCode) : '';
      const errText = escapeHtml(errDesc);
      await sendLogAlert('⚠️ Dead file_id, no backup', `Bundle <code>${bCode}</code> item has dead file_id but no storage backup. Error: ${errText}`).catch(() => {});
      break;
    }

    // If backup exists: Attempt copyMessages from the storage channel.
    let copyRes = null;
    let copyErr = null;
    try {
      const batchRes = await tgApi.copyMessages({
        chat_id: chatId,
        from_chat_id: targetChannelId,
        message_ids: [itemStorageId],
        protect_content: protect,
      });
      if (Array.isArray(batchRes) && batchRes.length > 0 && batchRes[0]?.message_id) {
        copyRes = batchRes[0];
      }
    } catch (bErr) {
      copyErr = bErr;
      try {
        const singleRes = await tgApi.copyMessage({
          chat_id: chatId,
          from_chat_id: targetChannelId,
          message_id: itemStorageId,
          protect_content: protect,
        });
        if (singleRes?.message_id) {
          copyRes = singleRes;
          copyErr = null;
        }
      } catch (sErr) {
        copyErr = sErr;
      }
    }

    if (!copyRes?.message_id) {
      const copyStatus = Number(copyErr?.code || copyErr?.status || 0);
      const copyDesc = String(copyErr?.description || copyErr?.message || '');
      if (copyStatus === 429 || copyErr?.parameters?.retry_after) {
        return { sentIds, deliveredCount, rateLimited: true, retryAfter: Number(copyErr?.parameters?.retry_after) || 60, pruned: false };
      }
      if (
        copyStatus === 403 ||
        (copyStatus === 400 && /CHAT_ADMIN_REQUIRED|CHAT_FORWARDS_RESTRICTED|kicked|chat not found/i.test(copyDesc))
      ) {
        await setConfig('storage_channel_active', 'false');
        const channelText = escapeHtml(targetChannelId);
        const copyText = escapeHtml(copyDesc);
        await sendLogAlert('🚨 Storage Channel Error', `Storage channel deactivated. Chat <code>${channelText}</code>: ${copyText}`).catch(() => {});
      } else {
        const bCode = bundleCode ? escapeHtml(bundleCode) : '';
        const copyText = escapeHtml(copyDesc);
        await sendLogAlert('⚠️ Copy Fallback Failed', `Bundle <code>${bCode}</code> backup copy failed: ${copyText}`).catch(() => {});
      }
      break;
    }

    // Copy succeeded!
    sentIds.push(copyRes.message_id);
    deliveredCount++;

    // Scenario C (Type mismatch self-healing): If the actual media type in storage differs from items record in DB, update the bundle's items in DB with the true media type.
    const actualType = detectActualMediaType(errDesc);
    if (actualType && actualType !== item.type && bundleCode) {
      item.type = actualType;
      try {
        const bRow = await db.select({ items: bundles.items }).from(bundles).where(eq(bundles.code, bundleCode)).get();
        if (bRow) {
          const allItems = typeof bRow.items === 'string' ? JSON.parse(bRow.items) : (Array.isArray(bRow.items) ? bRow.items : []);
          const updatedItems = allItems.map((it) => {
            const matchesUnique = item.file_unique_id && it.file_unique_id === item.file_unique_id;
            const matchesStorage = itemStorageId != null && (it.storage_message_id === itemStorageId || it.post_message_id === itemStorageId);
            const matchesFileId = item.file_id && it.file_id === item.file_id;
            if (matchesUnique || matchesStorage || matchesFileId) {
              return { ...it, type: actualType };
            }
            return it;
          });
          await db.update(bundles)
            .set({ items: updatedItems })
            .where(eq(bundles.code, bundleCode))
            .run();
        }
      } catch (dbErr) {
        console.error('Failed to self-heal bundle item type in DB:', dbErr);
      }
    }
  }

  return { sentIds, deliveredCount, rateLimited: false, pruned: false };
}

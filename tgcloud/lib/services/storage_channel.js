import { api } from 'sdk';
import {
  db as defaultDb, getConfig, tgApi as defaultTgApi, escapeHtml,
} from '../helpers.js';
import { sendLogAlert } from './log_channel.js';
import { setStorageSnapshot, getStorageSnapshot, disableStorageSnapshot } from '../shared/config.js';

export const DELIVERY_LIFECYCLE_HOOKS = true;
const MEDIA_METHODS = {
  photo: 'sendPhoto', document: 'sendDocument', video: 'sendVideo', audio: 'sendAudio',
  voice: 'sendVoice', video_note: 'sendVideoNote', animation: 'sendAnimation', sticker: 'sendSticker',
};
const positiveMessageId = (id) => Number.isSafeInteger(id) && id > 0;

// Classify an actual invoked method in context. Description text alone is not
// evidence of a rejected source reference, particularly for transport/5xx errors.
export function classifyDeliveryError(error, context = {}) {
  const code = Number(error?.code || 0);
  const description = String(error?.description || error?.message || '');
  const method = context.method;
  const knownMethod = Object.values(MEDIA_METHODS).includes(method) || method === 'copyMessages';
  if (!knownMethod || (error?.method && error.method !== method)) return { kind: 'unknown' };
  if (code === 429) {
    const delay = Number(error?.parameters?.retry_after);
    return { kind: 'rate_limited', retryAfter: Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : 60 };
  }
  // Unexpected recovery parameters contradict a source-reference diagnosis.
  // Preserve uncertain outcomes rather than inferring delivery rejection.
  if (error?.parameters?.retry_after !== undefined || error?.parameters?.migrate_to_chat_id !== undefined) {
    const delay = Number(error?.parameters?.retry_after);
    return { kind: 'unknown', ...(Number.isFinite(delay) && delay > 0 ? { retryAfter: Math.ceil(delay) } : {}) };
  }
  if (code < 400 || code >= 500) return { kind: 'unknown' };
  if (/blocked by the user|user is deactivated|bot cannot initiate|bot can.t initiate|chat not found/i.test(description)) {
    return { kind: 'recipient' };
  }
  if (context.source === 'file_id' && code === 400 && Object.values(MEDIA_METHODS).includes(method)
    && /^(?:Bad Request:\s*)?(?:FILE_REFERENCE_EXPIRED|file reference (?:has )?expired|wrong (?:remote )?file identifier(?:\/HTTP URL)? specified(?:[:.].*)?|invalid file[_ ]id)(?:\s*\.?$)/i.test(description)) {
    return { kind: 'source_dead' };
  }
  if (context.source === 'storage' && method === 'copyMessages' && [400, 403].includes(code)) {
    // Protected-source errors name the source. Membership errors are attributed
    // to storage only when the destination is a private recipient, not a channel.
    const protectedSource = /CHAT_FORWARDS_RESTRICTED|message is protected/i.test(description);
    const sourceMembership = Number(context.destinationChatId) > 0
      && /bot was kicked from (?:the )?channel|bot is not a member of (?:the )?channel/i.test(description);
    if (context.sourceChannelId && (protectedSource || sourceMembership)) return { kind: 'storage_fatal' };
  }
  return { kind: 'definitive' };
}

// These fields are the recorded copy provenance. A legacy post ID or the
// currently configured channel cannot supply missing historical provenance.
export function backupReference(item) {
  const channel = typeof item?.storage_channel_id === 'string' || typeof item?.storage_channel_id === 'number'
    ? String(item.storage_channel_id).trim() : '';
  if (!/^-100[0-9]+$/.test(channel) || !Number.isSafeInteger(Number(channel))
    || !positiveMessageId(item?.storage_message_id)) return null;
  return { channelId: channel, messageId: item.storage_message_id };
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
  await setStorageSnapshot({ channel_id: cleanId, enabled: true });
  return { ok: true, channelId: cleanId };
}

/**
 * Copy media to storage channel:
 * - If storageChannelId is configured, copy the message via tgApi.copyMessage and return { message_id, channel_id }.
 * - Configuration failure handling belongs to the caller's captured snapshot.
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

  const copyRes = await tgApi.copyMessage({
    chat_id: storageChannelId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
  if (Number.isSafeInteger(copyRes?.message_id) && copyRes.message_id > 0) {
    return { message_id: copyRes.message_id, channel_id: String(storageChannelId) };
  }
  throw new Error('No positive message_id in copyMessage response');
}

// One source message per copyMessages call gives an unambiguous receipt mapping.
// Hooks persist each boundary and receipt; bookkeeping errors deliberately
// propagate outside the Telegram catch and can never trigger another send.
export async function deliverMediaItems(chatId, items, tgApi = defaultTgApi, options = {}) {
  const protect = Boolean(options.protect || options.protect_content);
  const sentIds = [];
  const result = (outcome = null) => ({ sentIds, deliveredCount: sentIds.length,
    rateLimited: outcome?.kind === 'rate_limited',
    ...(outcome?.retryAfter ? { retryAfter: outcome.retryAfter } : {}),
    unknown: outcome?.kind === 'unknown', definitiveFailure: Boolean(outcome && !['unknown', 'rate_limited'].includes(outcome.kind)),
    pruned: false, ...(outcome ? { outcome } : {}),
  });
  const notifyOutcome = async (item, outcome) => {
    if (options.onOutcome) await options.onOutcome(item, outcome);
  };
  const confirm = async (item, id, stage) => {
    if (options.onConfirmed) await options.onConfirmed(item, id, stage);
    sentIds.push(id);
  };
  const invoke = (method, payload) => {
    const target = tgApi && typeof tgApi[method] === 'function' ? tgApi : api;
    return target[method](payload);
  };
  for (const item of items) {
    let primaryOutcome = { kind: 'source_dead' };
    if (item.file_id) {
      const type = MEDIA_METHODS[item.type] ? item.type : 'document';
      const method = MEDIA_METHODS[type];
      const payload = { chat_id: chatId, protect_content: protect, [type]: item.file_id };
      if (item.caption && ['photo', 'document', 'video', 'audio', 'voice', 'animation'].includes(type)) {
        payload.caption = escapeHtml(String(item.caption).slice(0, 1024));
        payload.parse_mode = 'HTML';
      }
      if (options.beforeDispatch) await options.beforeDispatch(item, 'primary', method);
      let response;
      try {
        response = await invoke(method, payload);
        primaryOutcome = null;
      } catch (error) {
        primaryOutcome = classifyDeliveryError(error, { method, source: 'file_id', destinationChatId: chatId });
      }
      if (!primaryOutcome) {
        if (positiveMessageId(response?.message_id)) {
          await confirm(item, response.message_id, 'primary');
          continue;
        }
        primaryOutcome = { kind: 'unknown' };
      }
      await notifyOutcome(item, primaryOutcome);
      if (primaryOutcome.kind !== 'source_dead') return result(primaryOutcome);
    }
    const reference = backupReference(item);
    const snapshot = await getStorageSnapshot();
    if (!snapshot.enabled || !reference) {
      const outcome = { kind: 'definitive' };
      await notifyOutcome(item, outcome);
      return result(outcome);
    }
    if (options.beforeDispatch) await options.beforeDispatch(item, 'backup', 'copyMessages');
    let response, copyError, outcome;
    try {
      response = await invoke('copyMessages', { chat_id: chatId, from_chat_id: reference.channelId,
        message_ids: [reference.messageId], protect_content: protect });
    } catch (error) {
      copyError = error;
      outcome = classifyDeliveryError(error, { method: 'copyMessages', source: 'storage',
        sourceChannelId: reference.channelId, destinationChatId: chatId });
    }
    if (!outcome && Array.isArray(response) && response.length === 1 && positiveMessageId(response[0]?.message_id)) {
      // copyMessages returns MessageId objects, so no source file/type metadata
      // can be repaired from this response. The existing item remains unchanged.
      await confirm(item, response[0].message_id, 'backup');
      continue;
    }
    outcome ||= { kind: 'unknown' };
    await notifyOutcome(item, outcome);
    if (outcome.kind === 'storage_fatal' && snapshot.channel_id === reference.channelId) {
      // Storage and logging remain optional. A late error is fenced by the
      // exact captured generation, including configure-away-and-back races.
      try {
        if (await disableStorageSnapshot(snapshot)) {
          await sendLogAlert('Storage Channel Error', `Storage channel deactivated: ${escapeHtml(reference.channelId)}. ${escapeHtml(String(copyError?.description || 'Source is inaccessible'))}`).catch(() => {});
        }
      } catch (_) {}
    }
    return result(outcome);
  }
  return result();
}

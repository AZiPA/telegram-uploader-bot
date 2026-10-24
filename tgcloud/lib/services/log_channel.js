import { db as defaultDb, getEffectiveOwnerId, escapeHtml } from '../helpers.js';
import { getConfig, setConfig } from '../shared/config.js';
import { tgApi as defaultTgApi } from '../shared/telegram.js';
import { t } from '../locales/index.js';

export async function isLogChannelActive(db = defaultDb) {
  const active = await getConfig('log_channel_active', 'false');
  return active === 'true';
}

/**
 * Read log_channel_id from systemConfig.
 * Returns null if not configured or disabled.
 *
 * @param {object} [db]
 * @returns {Promise<string|null>}
 */
export async function getLogChannelId(db = defaultDb) {
  let val = await getConfig('log_channel_id', null);
  if (!val) {
    val = await getConfig('log_channel', null);
  }
  if (!val) return null;
  const trimmed = typeof val === 'string' ? val.trim() : String(val).trim();
  if (!trimmed || ['off', '0', 'clear', 'disable', 'none'].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

/**
 * Send a formatted HTML log alert:
 * - Safely retrieve log_channel_id.
 * - If unset or null, return immediately without throwing errors.
 * - If configured, send formatted HTML alert to the log channel (or owner chat if set to 'owner'/'me').
 * - Wrap in try/catch to ensure logging failures never interrupt primary bot operations.
 *
 * @param {string} title
 * @param {string} [text]
 * @param {object} [tgApi]
 * @param {object} [db]
 * @returns {Promise<void>}
 */
export async function sendLogAlert(title, text, tgApi = defaultTgApi, db = defaultDb) {
  try {
    const logActive = (await getConfig('log_channel_active', 'false')) === 'true';
    if (!logActive) return;

    let messageText = '';
    let api = tgApi || defaultTgApi;
    let database = db || defaultDb;

    // Support both sendLogAlert(title, text, tgApi, db) and sendLogAlert(message, tgApi, db)
    if (typeof text !== 'string' && text !== undefined && text !== null) {
      database = api || database;
      api = text;
      messageText = String(title || '');
    } else if (text) {
      messageText = `<b>${title}</b>\n\n${text}`;
    } else {
      messageText = String(title || '');
    }

    if (!messageText) return;

    const logTarget = await getLogChannelId(database);
    if (!logTarget) return;

    let targetChatId = logTarget;
    if (logTarget.toLowerCase() === 'owner' || logTarget.toLowerCase() === 'me') {
      const ownerId = await getEffectiveOwnerId();
      if (!ownerId) return;
      targetChatId = ownerId;
    }

    await api.sendMessage({
      chat_id: targetChatId,
      text: messageText,
      parse_mode: 'HTML',
    });
  } catch (err) {
    const status = Number(err?.code || err?.status || 0);
    const desc = String(err?.description || err?.message || '');
    if (
      status === 400 ||
      status === 403 ||
      desc.includes('CHAT_ADMIN_REQUIRED') ||
      desc.toLowerCase().includes('kicked') ||
      desc.toLowerCase().includes('chat not found')
    ) {
      try {
        await setConfig('log_channel_active', 'false');
      } catch (_) {}
    }
    // Loop prevention: NEVER try to log a log-channel failure to itself.
    console.error('Failed to send log alert:', desc || err);
  }
}

/**
 * Helper to alert admins when tgApi.copyMessages returns fewer items than expected.
 *
 * @param {string} bundleCode
 * @param {number} expectedCount
 * @param {number} deliveredCount
 * @param {object} [tgApi]
 * @param {object} [db]
 * @returns {Promise<void>}
 */
export async function logMissingStorageItems(bundleCode, expectedCount, deliveredCount, tgApi = defaultTgApi, db = defaultDb) {
  const missingCount = Math.max(0, expectedCount - deliveredCount);
  if (missingCount <= 0) return;
  const title = '⚠️ Missing Storage Messages';
  const text = `Bundle <code>${escapeHtml(bundleCode)}</code> skipped ${missingCount} missing message(s). (Expected: ${expectedCount}, delivered: ${deliveredCount})`;
  await sendLogAlert(title, text, tgApi, db);
}

/**
 * Helper to alert admins when Telegram rate limits (HTTP 429) are encountered.
 *
 * @param {string|number} chatId
 * @param {number} retryAfter
 * @param {object} [tgApi]
 * @param {object} [db]
 * @returns {Promise<void>}
 */
export async function logRateLimitHit(chatId, retryAfter, tgApi = defaultTgApi, db = defaultDb) {
  const title = '🚨 Rate Limit Hit (429)';
  const text = `Telegram rate limit hit for chat <code>${escapeHtml(String(chatId))}</code>. Retry after: ${Number(retryAfter) || 60}s.`;
  await sendLogAlert(title, text, tgApi, db);
}

/**
 * Helper to alert admins when Telegram custom emojis are invalid (ENTITY_CUSTOM_EMOJI_INVALID).
 * Dispatches localized warning that premium emojis have been auto-disabled.
 *
 * @param {object} [tgApi]
 * @param {object} [db]
 * @returns {Promise<void>}
 */
export async function notifyCustomEmojiDisabled(tgApi = defaultTgApi, db = defaultDb) {
  try {
    const logActive = (await getConfig('log_channel_active', 'false')) === 'true';
    if (!logActive) return;

    const database = db || defaultDb;
    const api = tgApi || defaultTgApi;
    const logTarget = await getLogChannelId(database);
    if (!logTarget) return;

    let targetChatId = logTarget;
    if (logTarget.toLowerCase() === 'owner' || logTarget.toLowerCase() === 'me') {
      const ownerId = await getEffectiveOwnerId();
      if (!ownerId) return;
      targetChatId = ownerId;
    }

    let lang = 'en';
    try {
      const configuredLang = await getConfig('language', null);
      if (configuredLang) {
        lang = configuredLang;
      } else {
        const fallbackLang = await getConfig('default_lang', 'en');
        lang = fallbackLang || 'en';
      }
    } catch (_) {}
    if (!['en', 'fa'].includes(lang)) lang = 'en';

    const messageText = t(lang, 'log_pe_auto_disabled');
    await api.sendMessage({
      chat_id: targetChatId,
      text: messageText,
      parse_mode: 'HTML',
    });
  } catch (err) {
    const status = Number(err?.code || err?.status || 0);
    const desc = String(err?.description || err?.message || '');
    if (
      status === 400 ||
      status === 403 ||
      desc.includes('CHAT_ADMIN_REQUIRED') ||
      desc.toLowerCase().includes('kicked') ||
      desc.toLowerCase().includes('chat not found')
    ) {
      try {
        await setConfig('log_channel_active', 'false');
      } catch (_) {}
    }
    console.error('Failed to send custom emoji auto-disabled log alert:', desc || err);
  }
}

export const logCustomEmojiDisabled = notifyCustomEmojiDisabled;

import { api, db } from 'sdk';
import { systemConfig } from '../../schema.js';
import { setConfig, configCache } from './config.js';
import { notifyCustomEmojiDisabled } from '../services/log_channel.js';
import { splitStandardMessage, splitRichMessage } from './formatters.js';

export const tgApi = {
  sendMessage: (p) => api.sendMessage(p),
  sendRichMessage: (p) => {
    const richPayload = typeof p.rich_message === 'object' && p.rich_message !== null
      ? p.rich_message
      : { html: String(p.rich_message || p.text || '') };
    return api.sendRichMessage({ chat_id: p.chat_id, rich_message: richPayload, ...p });
  },
  editMessageText: (p) => api.editMessageText(p),
  editMessageReplyMarkup: (p) => api.editMessageReplyMarkup(p),
  answerCallbackQuery: (p) => api.answerCallbackQuery(p),
  deleteMessage: (p) => api.deleteMessage(p),
  deleteMessages: (p) => api.deleteMessages(p),
  copyMessage: (p) => api.copyMessage(p),
  copyMessages: (p) => api.copyMessages(p),
  sendDocument: (p) => api.sendDocument(p),
  sendVideo: (p) => api.sendVideo(p),
  sendAudio: (p) => api.sendAudio(p),
  sendPhoto: (p) => api.sendPhoto(p),
  sendVoice: (p) => api.sendVoice(p),
  sendVideoNote: (p) => api.sendVideoNote(p),
  sendAnimation: (p) => api.sendAnimation(p),
  sendSticker: (p) => api.sendSticker(p),
  getChat: (p) => api.getChat(p),
  getChatMember: (p) => api.getChatMember(p),
  createChatInviteLink: (p) => api.createChatInviteLink(p),
  revokeChatInviteLink: (p) => api.revokeChatInviteLink(p),
  getMe: (p = {}) => api.getMe(p),
  setMyName: (p) => api.setMyName(p),
  setMyDescription: (p) => api.setMyDescription(p),
  setMyShortDescription: (p) => api.setMyShortDescription(p),
  getMyName: (p = {}) => api.getMyName(p),
  getMyDescription: (p = {}) => api.getMyDescription(p),
  getMyShortDescription: (p = {}) => api.getMyShortDescription(p),
  setMyProfilePhoto: (p) => api.setMyProfilePhoto(p),
  removeMyProfilePhoto: (p = {}) => api.removeMyProfilePhoto(p),
  getFileContent: (p) => api.getFileContent(p),
  getFileStream: (p) => api.getFileStream(p),
  getFile: (p) => api.getFile(p),
};

export function buildForceReply(placeholder = '') {
  return {
    force_reply: true,
    selective: true,
    ...(placeholder ? { input_field_placeholder: String(placeholder).slice(0, 64) } : {}),
  };
}

export function stripCustomEmojiTags(html) {
  if (!html || typeof html !== 'string') return html;
  // Replaces <tg-emoji emoji-id="...">FALLBACK</tg-emoji> with just FALLBACK
  return html.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, '$1');
}

export function stripCustomEmojiFromMarkup(markup) {
  if (!markup || typeof markup !== 'object') return markup;
  const cloned = JSON.parse(JSON.stringify(markup));
  if (Array.isArray(cloned.inline_keyboard)) {
    for (const row of cloned.inline_keyboard) {
      if (Array.isArray(row)) {
        for (const btn of row) {
          if (btn && 'icon_custom_emoji_id' in btn) {
            delete btn.icon_custom_emoji_id;
          }
        }
      }
    }
  }
  return cloned;
}

export function isCustomEmojiError(err) {
  const desc = String(err?.description || err?.message || '');
  return desc.includes('ENTITY_CUSTOM_EMOJI_INVALID') || desc.toLowerCase().includes('custom emoji');
}

export async function handleCustomEmojiCircuitBreaker() {
  try {
    if (typeof setConfig === 'function') {
      await setConfig('premium_emojis_enabled', 'false');
    } else if (db && systemConfig) {
      await db.insert(systemConfig)
        .values({ key: 'premium_emojis_enabled', value: 'false' })
        .onConflictDoUpdate({
          target: systemConfig.key,
          set: { value: 'false' },
        })
        .run();
    }
  } catch (_) {
    try {
      if (typeof db?.prepare === 'function') {
        await db.prepare("UPDATE system_config SET value = 'false' WHERE key = 'premium_emojis_enabled'").run();
      }
    } catch (_) {}
  }

  try {
    if (configCache && typeof configCache.set === 'function') {
      configCache.set('premium_emojis_enabled', { raw: 'false', exp: Math.floor(Date.now() / 1000) + 60 });
    }
  } catch (_) {}

  try {
    await notifyCustomEmojiDisabled(tgApi, db);
  } catch (err) {
    console.error('Failed to notify log channel of custom emoji circuit breaker:', err?.description || err?.message || err);
  }
}

export const defaultTgApi = tgApi;

export async function sendMsg(chatId, text, replyMarkup = null, extra = {}) {
  const isMarkupObj = replyMarkup && typeof replyMarkup === 'object' && !Array.isArray(replyMarkup) && ('reply_markup' in replyMarkup || 'parse_mode' in replyMarkup || Object.keys(replyMarkup).length === 0);
  const payload = isMarkupObj
    ? {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...replyMarkup,
      }
    : {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...extra,
      };

  try {
    return await tgApi.sendMessage(payload);
  } catch (err) {
    if (isCustomEmojiError(err)) {
      await handleCustomEmojiCircuitBreaker();
      const cleanText = stripCustomEmojiTags(text);
      const cleanPayload = {
        ...payload,
        text: cleanText,
      };
      if (cleanPayload.reply_markup) {
        cleanPayload.reply_markup = stripCustomEmojiFromMarkup(cleanPayload.reply_markup);
      }
      return await tgApi.sendMessage(cleanPayload);
    }
    throw err;
  }
}

export async function sendSplitMsg(chatId, text, opts = {}, isRich = false) {
  if (isRich) {
    const chunks = splitRichMessage(text, 32000);
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      const res = await defaultTgApi.sendRichMessage({
        chat_id: chatId,
        rich_message: { html: chunks[i] },
        ...(i === chunks.length - 1 ? opts : {})
      });
      results.push(res);
    }
    return results;
  }

  const chunks = splitStandardMessage(text, 4000);
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkOpts = {
      parse_mode: 'HTML',
      ...opts,
    };
    if (i === chunks.length - 1 && opts.reply_markup) {
      chunkOpts.reply_markup = opts.reply_markup;
    } else {
      delete chunkOpts.reply_markup;
    }
    const res = await sendMsg(chatId, chunks[i], chunkOpts);
    results.push(res);
  }
  return results;
}

export async function editMsg(chatId, messageId, text, replyMarkup = null, fallbackToSend = false) {
  let opts = (replyMarkup && typeof replyMarkup === 'object' && ('reply_markup' in replyMarkup || 'parse_mode' in replyMarkup))
    ? { ...replyMarkup }
    : { ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };

  // Sanitize: Telegram API rejects explicit null for reply_markup
  if ('reply_markup' in opts && (opts.reply_markup === null || opts.reply_markup === undefined)) {
    delete opts.reply_markup;
  }

  try {
    return await tgApi.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...opts,
    });
  } catch (err) {
    if (isCustomEmojiError(err)) {
      await handleCustomEmojiCircuitBreaker();
      const cleanText = stripCustomEmojiTags(text);
      const cleanOpts = { ...opts };
      if (cleanOpts.reply_markup) {
        cleanOpts.reply_markup = stripCustomEmojiFromMarkup(cleanOpts.reply_markup);
      }
      try {
        return await tgApi.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: cleanText,
          parse_mode: 'HTML',
          ...cleanOpts,
        });
      } catch (retryErr) {
        const retryDesc = String(retryErr?.description || retryErr?.message || '');
        if (retryDesc.toLowerCase().includes('message is not modified')) {
          return null;
        }
        if (fallbackToSend) {
          return sendMsg(chatId, cleanText, cleanOpts.reply_markup || replyMarkup);
        }
        throw retryErr;
      }
    }

    const desc = String(err?.description || err?.message || '');
    if (desc.toLowerCase().includes('message is not modified')) {
      return null;
    }
    if (fallbackToSend) {
      return sendMsg(chatId, text, replyMarkup);
    }
    throw err;
  }
}

export async function editMarkup(chatId, messageId, replyMarkup) {
  return tgApi.editMessageReplyMarkup({
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  }).catch(() => {});
}

export async function answerCq(cq, text = undefined, showAlert = false) {
  if (cq) cq._answered = true;
  return tgApi.answerCallbackQuery({
    callback_query_id: cq?.id,
    ...(text ? { text: String(text).replace(/<[^>]+>/g, '') } : {}),
    ...(showAlert ? { show_alert: true } : {}),
  }).catch(() => {});
}

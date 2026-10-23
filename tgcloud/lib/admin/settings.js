import {
  db as defaultDb, setConfig, getRoleLevel, escapeHtml, LIMITS,
  tgApi as defaultTgApi, getEffectiveOwnerId
} from '../helpers.js';
import { isPremiumEmojiEnabled } from '../shared/emojis.js';
import { t } from '../locales/index.js';
import { sendMsg, editMsg, answerCq } from '../helpers.js';
import { formatDailyCap } from '../shared/formatters.js';
import {
  buildSettingsKeyboard as buildBaseSettingsKeyboard,
  getSettingsKeyboardOpts,
  handleSettingsCallback as handlePanelCallback
} from './settings_panel.js';
import { registerStorageChannel } from '../services/storage_channel.js';
import {
  SUPPORTED_FILE_MEDIA_TYPES,
  getAllowedMediaTypes,
  toggleMediaType,
  enableAllMediaTypes
} from '../services/media_config.js';

export function getMediaTypeName(type, lang) {
  switch (type) {
    case 'photo': return t(lang, 'media_type_photo');
    case 'document': return t(lang, 'media_type_document');
    case 'video': return t(lang, 'media_type_video');
    case 'audio': return t(lang, 'media_type_audio');
    case 'voice': return t(lang, 'media_type_voice');
    case 'video_note': return t(lang, 'media_type_video_note');
    case 'animation': return t(lang, 'media_type_animation');
    case 'sticker': return t(lang, 'media_type_sticker');
    default: return type;
  }
}

export function buildSettingsKeyboard(lang, opts = {}, userLevel = 0) {
  return buildBaseSettingsKeyboard(lang, opts, userLevel);
}

export async function renderSettingsPanel(chatId, messageId = null, db = defaultDb, lang = 'en', api = defaultTgApi, userLevel = 0) {
  let targetLang = lang;
  let targetUserLevel = userLevel;
  let targetApi = api;
  let targetDb = db;

  if (typeof db === 'string') {
    targetLang = db;
    targetUserLevel = typeof lang === 'number' ? lang : 0;
    targetDb = defaultDb;
    targetApi = defaultTgApi;
  }

  const opts = await getSettingsKeyboardOpts(targetLang);
  if (targetUserLevel === 4) {
    opts.peEnabled = await isPremiumEmojiEnabled(targetDb);
  }
  const keyboard = buildSettingsKeyboard(targetLang, opts, targetUserLevel);

  if (messageId) {
    if (targetApi && typeof targetApi.editMessageText === 'function') {
      return targetApi.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: t(targetLang, 'settings_title'),
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }).catch((err) => {
        const desc = String(err?.description || err?.message || '');
        if (desc.toLowerCase().includes('message is not modified')) return null;
        throw err;
      });
    }
    return editMsg(chatId, messageId, t(targetLang, 'settings_title'), { reply_markup: keyboard });
  }

  if (targetApi && typeof targetApi.sendMessage === 'function') {
    return targetApi.sendMessage({
      chat_id: chatId,
      text: t(targetLang, 'settings_title'),
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
  return sendMsg(chatId, t(targetLang, 'settings_title'), { reply_markup: keyboard });
}

export async function renderMediaTypesPanel(chatId, messageId, db = defaultDb, lang = 'en', api = defaultTgApi) {
  const allowed = await getAllowedMediaTypes(db);
  const rows = [];

  for (let i = 0; i < SUPPORTED_FILE_MEDIA_TYPES.length; i += 2) {
    const row = [];
    const t1 = SUPPORTED_FILE_MEDIA_TYPES[i];
    const ok1 = allowed.includes(t1);
    const label1 = getMediaTypeName(t1, lang);
    row.push({
      text: `${ok1 ? '✅' : '❌'} ${label1}`,
      callback_data: `mng:mt_toggle:${t1}`,
      style: ok1 ? 'success' : 'danger',
    });
    if (i + 1 < SUPPORTED_FILE_MEDIA_TYPES.length) {
      const t2 = SUPPORTED_FILE_MEDIA_TYPES[i + 1];
      const ok2 = allowed.includes(t2);
      const label2 = getMediaTypeName(t2, lang);
      row.push({
        text: `${ok2 ? '✅' : '❌'} ${label2}`,
        callback_data: `mng:mt_toggle:${t2}`,
        style: ok2 ? 'success' : 'danger',
      });
    }
    rows.push(row);
  }

  rows.push([
    { text: `🔄 ${t(lang, 'btn_enable_all')}`, callback_data: 'mng:mt_all', style: 'primary' }
  ]);
  rows.push([
    { text: `🔙 ${t(lang, 'btn_back_settings')}`, callback_data: 'mng:settings' }
  ]);

  const text = `<blockquote>⚙️ <b>${t(lang, 'media_types_title')}</b></blockquote>`;
  const reply_markup = { inline_keyboard: rows };

  if (messageId) {
    if (api && typeof api.editMessageText === 'function') {
      return api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup,
      }).catch((err) => {
        const desc = String(err?.description || err?.message || '');
        if (desc.toLowerCase().includes('message is not modified')) return null;
        throw err;
      });
    }
    return editMsg(chatId, messageId, text, { reply_markup });
  }

  if (api && typeof api.sendMessage === 'function') {
    return api.sendMessage({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup,
    });
  }
  return sendMsg(chatId, text, { reply_markup });
}

export async function handleSettingsCallback(data, cq, userId, chatId, messageId, lang = 'en', role = 'user', db = defaultDb, api = defaultTgApi, userLevel = null) {
  const actualDb = (db && typeof db.select === 'function') ? db : defaultDb;
  const actualApi = (api && typeof api.sendMessage === 'function') ? api : defaultTgApi;
  const ownerId = await getEffectiveOwnerId();
  const isOwner = (userId && ownerId && Number(userId) === Number(ownerId)) || role === 'owner';
  const effectiveUserLevel = isOwner ? 4 : (userLevel != null ? userLevel : getRoleLevel(role));

  if (data === 'mng:toggle_pe') {
    if (effectiveUserLevel < 4) {
      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({
            callback_query_id: cq.id,
            text: t(lang, 'superadmin_only_command').replace(/<[^>]+>/g, ''),
            show_alert: true,
          }).catch(() => {});
        } else {
          await answerCq(cq, t(lang, 'superadmin_only_command'), true);
        }
      }
      return false;
    }

    const isEnabled = await isPremiumEmojiEnabled(actualDb);
    const tgApi = actualApi;

    if (!isEnabled) {
      const testChatId = ownerId || chatId || userId;
      let testMsg = null;
      try {
        testMsg = await tgApi.sendMessage({
          chat_id: testChatId,
          text: '<tg-emoji emoji-id="6226477633052350835">📦</tg-emoji> [Self-Test]',
          parse_mode: 'HTML',
        });
      } catch (err) {
        if (actualDb && typeof actualDb.prepare === 'function') {
          try {
            await actualDb.prepare("update system_config set value = 'false' where key = 'premium_emojis_enabled'").run();
          } catch (_) {}
        }
        await setConfig('premium_emojis_enabled', 'false');

        const errDesc = String(err?.description || err?.message || '');
        const isEmojiInvalid = errDesc.includes('ENTITY_CUSTOM_EMOJI_INVALID') || errDesc.includes('CUSTOM_EMOJIS_NOT_ALLOWED');

        if (isEmojiInvalid) {
          if (cq) {
            if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
              await actualApi.answerCallbackQuery({
                callback_query_id: cq.id,
                text: t(lang, 'pe_err_not_supported').replace(/<[^>]+>/g, ''),
                show_alert: true,
              }).catch(() => {});
            } else {
              await answerCq(cq, t(lang, 'pe_err_not_supported'), true);
            }
          }
        } else {
          if (cq) {
            if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
              await actualApi.answerCallbackQuery({
                callback_query_id: cq.id,
                text: t(lang, 'pe_test_failed').replace(/<[^>]+>/g, ''),
                show_alert: true,
              }).catch(() => {});
            } else {
              await answerCq(cq, t(lang, 'pe_test_failed'), true);
            }
          }
        }
        return true;
      }

      if (testMsg?.message_id) {
        await tgApi.deleteMessage({
          chat_id: testChatId,
          message_id: testMsg.message_id,
        }).catch(() => {});
      }

      const hasCustomEmoji = Array.isArray(testMsg?.entities) && 
        testMsg.entities.some(ent => ent.type === 'custom_emoji');

      if (!hasCustomEmoji) {
        if (actualDb && typeof actualDb.prepare === 'function') {
          try {
            await actualDb.prepare("update system_config set value = 'false' where key = 'premium_emojis_enabled'").run();
          } catch (_) {}
        }
        await setConfig('premium_emojis_enabled', 'false');

        if (cq) {
          if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
            await actualApi.answerCallbackQuery({
              callback_query_id: cq.id,
              text: t(lang, 'pe_err_not_supported').replace(/<[^>]+>/g, ''),
              show_alert: true,
            }).catch(() => {});
          } else {
            await answerCq(cq, t(lang, 'pe_err_not_supported'), true);
          }
        }
        return true;
      }

      if (actualDb && typeof actualDb.prepare === 'function') {
        try {
          await actualDb.prepare("insert into system_config (key, value) values ('premium_emojis_enabled', 'true') on conflict(key) do update set value = 'true'").run();
        } catch (_) {}
      }
      await setConfig('premium_emojis_enabled', 'true');

      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({
            callback_query_id: cq.id,
            text: t(lang, 'pe_enabled').replace(/<[^>]+>/g, ''),
            show_alert: false,
          }).catch(() => {});
        } else {
          await answerCq(cq, t(lang, 'pe_enabled'));
        }
      }
      await renderSettingsPanel(chatId, messageId, actualDb, lang, actualApi, effectiveUserLevel);
      return true;
    } else {
      if (actualDb && typeof actualDb.prepare === 'function') {
        try {
          await actualDb.prepare("update system_config set value = 'false' where key = 'premium_emojis_enabled'").run();
        } catch (_) {}
      }
      await setConfig('premium_emojis_enabled', 'false');

      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({
            callback_query_id: cq.id,
            text: t(lang, 'pe_disabled').replace(/<[^>]+>/g, ''),
            show_alert: false,
          }).catch(() => {});
        } else {
          await answerCq(cq, t(lang, 'pe_disabled'));
        }
      }
      await renderSettingsPanel(chatId, messageId, actualDb, lang, actualApi, effectiveUserLevel);
      return true;
    }
  }

  if (data === 'mng:mt_menu' || data?.startsWith('mng:mt_toggle:') || data === 'mng:mt_all' || data === 'mng:settings') {
    if (effectiveUserLevel < 4) {
      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({
            callback_query_id: cq.id,
            text: t(lang, 'superadmin_only_command').replace(/<[^>]+>/g, ''),
            show_alert: true,
          }).catch(() => {});
        } else {
          await answerCq(cq, t(lang, 'superadmin_only_command'), true);
        }
      }
      return false;
    }

    if (data === 'mng:mt_menu') {
      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});
        } else {
          await answerCq(cq);
        }
      }
      await renderMediaTypesPanel(chatId, messageId, actualDb, lang, actualApi);
      return true;
    }

    if (data.startsWith('mng:mt_toggle:')) {
      const type = data.slice('mng:mt_toggle:'.length);
      if (SUPPORTED_FILE_MEDIA_TYPES.includes(type)) {
        await toggleMediaType(type, actualDb);
      }
      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});
        } else {
          await answerCq(cq);
        }
      }
      await renderMediaTypesPanel(chatId, messageId, actualDb, lang, actualApi);
      return true;
    }

    if (data === 'mng:mt_all') {
      await enableAllMediaTypes(actualDb);
      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});
        } else {
          await answerCq(cq);
        }
      }
      await renderMediaTypesPanel(chatId, messageId, actualDb, lang, actualApi);
      return true;
    }

    if (data === 'mng:settings') {
      if (cq) {
        if (actualApi && typeof actualApi.answerCallbackQuery === 'function') {
          await actualApi.answerCallbackQuery({ callback_query_id: cq.id }).catch(() => {});
        } else {
          await answerCq(cq);
        }
      }
      await renderSettingsPanel(chatId, messageId, actualDb, lang, actualApi, effectiveUserLevel);
      return true;
    }
  }

  return handlePanelCallback(data, cq, userId, chatId, messageId, lang, role, actualDb, actualApi, effectiveUserLevel);
}

export const handleMediaTypesCallback = handleSettingsCallback;

export async function handleSettingsCommand(cmd, arg, message, userId, chatId, lang, role) {
  if (cmd === '/settings') {
    const ownerId = await getEffectiveOwnerId();
    const isOwner = (userId && ownerId && Number(userId) === Number(ownerId)) || role === 'owner';
    const userLevel = isOwner ? 4 : getRoleLevel(role);
    return renderSettingsPanel(chatId, null, defaultDb, lang, defaultTgApi, userLevel);
  }

  if (cmd === '/setstoragechannel') {
    const ownerId = await getEffectiveOwnerId();
    const isOwner = (userId && ownerId && Number(userId) === Number(ownerId)) || role === 'owner';
    const userLevel = isOwner ? 4 : getRoleLevel(role);
    if (userLevel < 4) {
      return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    }
    if (!arg) return sendMsg(chatId, t(lang, 'setstoragechannel_usage'));
    const norm = arg.trim().toLowerCase();
    if (norm === 'off' || norm === 'clear' || norm === 'disable') {
      await setConfig('storage_channel_id', '');
      await setConfig('storage_channel_active', 'false');
      return sendMsg(chatId, t(lang, 'storagechannel_cleared'));
    }
    const chId = arg.trim();
    if (!chId.startsWith('-100')) {
      return sendMsg(chatId, t(lang, 'setstoragechannel_usage'));
    }
    const check = await registerStorageChannel(chId, userLevel, defaultTgApi);
    if (!check.ok) {
      if (check.reason === 'protected') {
        return sendMsg(chatId, t(lang, 'storagechannel_protected_error'));
      }
      if (check.reason === 'not_admin' || check.reason === 'cannot_post') {
        return sendMsg(chatId, t(lang, 'storagechannel_bot_not_admin'));
      }
      return sendMsg(chatId, t(lang, 'storagechannel_access_error', { err: escapeHtml(String(check.error?.description || check.error?.message || 'Unknown error')) }));
    }
    return sendMsg(chatId, t(lang, 'storagechannel_updated', { target: escapeHtml(chId) }));
  }

  if (cmd === '/setdailylimit' || cmd === '/setfilelimit' || cmd === '/setautodel' || cmd === '/setbundlettl') {
    const n = Number(arg?.trim());
    if (!arg || !Number.isInteger(n) || n < 0) {
      if (cmd === '/setdailylimit') return sendMsg(chatId, t(lang, 'daily_limit_updated', { val: formatDailyCap(0, lang) }));
      if (cmd === '/setfilelimit') return sendMsg(chatId, t(lang, 'file_limit_updated', { val: LIMITS.DEFAULT_FILE_DAILY_LIMIT }));
      if (cmd === '/setautodel') return sendMsg(chatId, t(lang, 'autodel_timer_updated', { val: '0' }));
      return sendMsg(chatId, t(lang, 'bundle_ttl_updated_msg', { val: '0' }));
    }
    if (cmd === '/setdailylimit') {
      await setConfig('daily_download_cap', String(n));
      return sendMsg(chatId, t(lang, 'daily_limit_updated', { val: formatDailyCap(n, lang) }));
    }
    if (cmd === '/setfilelimit') {
      await setConfig('file_daily_limit', String(n));
      return sendMsg(chatId, t(lang, 'file_limit_updated', { val: n || LIMITS.DEFAULT_FILE_DAILY_LIMIT }));
    }
    if (cmd === '/setautodel') {
      await setConfig('auto_delete_seconds', String(n));
      return sendMsg(chatId, t(lang, 'autodel_timer_updated', { val: n }));
    }
    await setConfig('bundle_ttl_hours', String(n));
    return sendMsg(chatId, t(lang, 'bundle_ttl_updated_msg', { val: n }));
  }

  if (cmd === '/setpubchannel') {
    if (!arg) return sendMsg(chatId, t(lang, 'usage_setpubchannel'));
    const norm = arg.trim().toLowerCase();
    if (norm === 'off' || norm === 'clear' || norm === 'disable') {
      await setConfig('pub_channel_id', '');
      return sendMsg(chatId, t(lang, 'pubchannel_cleared_msg'));
    }
    const chId = arg.trim();
    try {
      const me = await defaultTgApi.getMe({});
      const member = await defaultTgApi.getChatMember({ chat_id: chId, user_id: me.id });
      if (member.status !== 'administrator' && member.status !== 'creator') {
        return sendMsg(chatId, t(lang, 'channel_bot_not_admin'));
      }
    } catch (err) {
      return sendMsg(chatId, t(lang, 'channel_access_error', { err: escapeHtml(String(err?.description || err?.message || 'Unknown error')) }));
    }
    await setConfig('pub_channel_id', chId);
    return sendMsg(chatId, t(lang, 'pubchannel_updated_msg', { target: escapeHtml(chId) }));
  }

  if (cmd === '/setlogchannel') {
    if (!arg) return sendMsg(chatId, t(lang, 'setlogchannel_usage'));
    const norm = arg.trim().toLowerCase();
    if (norm === 'off' || norm === 'clear' || norm === 'disable') {
      await setConfig('log_channel_id', '');
      await setConfig('log_channel_active', 'false');
      return sendMsg(chatId, t(lang, 'setlogchannel_off'));
    }
    if (norm === 'owner' || norm === 'me') {
      await setConfig('log_channel_id', 'owner');
      await setConfig('log_channel_active', 'true');
      return sendMsg(chatId, t(lang, 'setlogchannel_owner'));
    }
    const logId = arg.trim();
    await setConfig('log_channel_id', logId);
    await setConfig('log_channel_active', 'true');
    return sendMsg(chatId, t(lang, 'setlogchannel_channel', { target: escapeHtml(logId) }));
  }

  if (cmd === '/setlang') {
    const newLang = arg.trim().toLowerCase() === 'fa' ? 'fa' : 'en';
    await setConfig('language', newLang);
    await setConfig('default_lang', newLang);
    return sendMsg(chatId, t(newLang, 'btn_settings_lang', { lang: newLang }));
  }

  return false;
}

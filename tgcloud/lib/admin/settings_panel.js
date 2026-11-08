import {
  getConfig, setConfig, getRoleLevel, ACTIONS,
  editMsg, editMarkup, answerCq, getEffectiveOwnerId
} from '../helpers.js';
import { formatAutoDelete, formatBundleTtl, formatDailyCap } from '../shared/formatters.js';
import { t } from '../locales/index.js';
import { isPremiumEmojiEnabled } from '../shared/emojis.js';

export function buildSettingsKeyboard(lang, opts = {}, userLevel = 0) {
  const autoDelStr = opts.autoDel ?? (opts.autoDelSec != null ? formatAutoDelete(opts.autoDelSec, lang) : t(lang, 'settings_val_off'));
  const ttlStr = opts.ttl ?? (opts.ttlHours != null ? formatBundleTtl(opts.ttlHours, lang) : t(lang, 'settings_val_forever'));
  const capStr = opts.cap ?? (opts.dailyCap != null ? opts.dailyCap : formatDailyCap(opts.dailyCapVal ?? opts.capVal ?? 0, lang));
  const currentLang = (opts.lang || lang || 'en').toUpperCase();

  const keyboard = {
    inline_keyboard: [
      [{ text: t(lang, 'btn_settings_daily_limit', { val: capStr }), callback_data: ACTIONS.SETTINGS_CAP }],
      [{
        text: t(lang, opts.isMaint ? 'btn_settings_maint_on' : 'btn_settings_maint_off'),
        callback_data: ACTIONS.SETTINGS_MAINT,
        style: opts.isMaint ? 'danger' : 'success'
      }],
      [{ text: t(lang, 'btn_settings_autodel', { val: autoDelStr }), callback_data: ACTIONS.SETTINGS_AUTODEL }],
      [{ text: t(lang, 'btn_settings_bundle_ttl', { val: ttlStr }), callback_data: ACTIONS.SETTINGS_BUNDLE_TTL }],
      [{
        text: t(lang, opts.isProtect ? 'btn_settings_protect_on' : 'btn_settings_protect_off'),
        callback_data: ACTIONS.SETTINGS_PROTECT,
        ...(opts.isProtect ? { style: 'success' } : {})
      }],
      [{ text: t(lang, 'btn_settings_lang', { lang: currentLang }), callback_data: ACTIONS.SETTINGS_LANG }],
      [{ text: t(lang, 'btn_edit_bot_profile'), callback_data: ACTIONS.BOT_PROFILE_MENU, style: 'primary' }]
    ]
  };

  if (userLevel === 4) {
    keyboard.inline_keyboard.push([
      { text: `🎛 ${t(lang, 'btn_media_types')}`, callback_data: 'mng:mt_menu', style: 'primary' }
    ]);
    const peText = opts.peEnabled ? t(lang, 'btn_pe_on') : t(lang, 'btn_pe_off');
    const peBtn = {
      text: `✨ ${peText}`,
      callback_data: 'mng:toggle_pe',
      ...(opts.peEnabled ? { style: 'success' } : {})
    };
    keyboard.inline_keyboard.push([peBtn]);
  }

  return keyboard;
}

export async function getSettingsKeyboardOpts(currentLang) {
  const isMaint = (await getConfig('maintenance')) === 'on' || (await getConfig('maintenance_mode', '0')) === '1';
  const isProtect = (await getConfig('default_protect_content', '0')) === '1';
  const autoDelSec = await getConfig('auto_delete_seconds', '0');
  const ttlHours = await getConfig('bundle_ttl_hours', '0');
  const dailyCap = await getConfig('daily_download_cap', '0');
  const activeLang = (await getConfig('language')) || (await getConfig('default_lang', currentLang || 'en')) || 'en';
  return {
    isMaint,
    isProtect,
    autoDel: formatAutoDelete(autoDelSec, activeLang),
    ttl: formatBundleTtl(ttlHours, activeLang),
    dailyCap: formatDailyCap(dailyCap, activeLang || currentLang || 'en'),
    cap: formatDailyCap(dailyCap, activeLang || currentLang || 'en'),
    lang: (activeLang || 'en').toUpperCase(),
  };
}

export async function handleSettingsCallback(data, cq, userId, chatId, messageId, lang = 'en', role = 'user', db = null, api = null, passedUserLevel = null) {
  const ownerId = await getEffectiveOwnerId();
  const isOwner = (userId && ownerId && Number(userId) === Number(ownerId)) || role === 'owner';
  const userLevel = isOwner ? 4 : (passedUserLevel !== null && passedUserLevel !== undefined ? passedUserLevel : getRoleLevel(role));

  if (data === ACTIONS.SETTINGS_MENU) {
    await answerCq(cq);
    const opts = await getSettingsKeyboardOpts(lang);
    if (userLevel === 4) {
      opts.peEnabled = await isPremiumEmojiEnabled();
    }
    return editMsg(chatId, messageId, t(lang, 'settings_title'), { reply_markup: buildSettingsKeyboard(lang, opts, userLevel) });
  }

  if (data === ACTIONS.SETTINGS_MAINT) {
    if (userLevel < 4) {
      return answerCq(cq, t(lang, 'superadmin_only_command'), true);
    }
    await answerCq(cq);
    const curM = (await getConfig('maintenance')) === 'on' || (await getConfig('maintenance_mode', '0')) === '1';
    const nextM = !curM;
    await setConfig('maintenance', nextM ? 'on' : 'off');
    await setConfig('maintenance_mode', nextM ? '1' : '0');
    const opts = await getSettingsKeyboardOpts(lang);
    if (userLevel === 4) {
      opts.peEnabled = await isPremiumEmojiEnabled();
    }
    return editMarkup(chatId, messageId, buildSettingsKeyboard(lang, opts, userLevel));
  }

  if (data === ACTIONS.SETTINGS_PROTECT) {
    await answerCq(cq);
    const curP = (await getConfig('default_protect_content', '0')) === '1';
    await setConfig('default_protect_content', curP ? '0' : '1');
    const opts = await getSettingsKeyboardOpts(lang);
    if (userLevel === 4) {
      opts.peEnabled = await isPremiumEmojiEnabled();
    }
    return editMarkup(chatId, messageId, buildSettingsKeyboard(lang, opts, userLevel));
  }

  if (data === ACTIONS.SETTINGS_AUTODEL) {
    await answerCq(cq);
    const cur = Number(await getConfig('auto_delete_seconds', '0')) || 0;
    const cycle = [0, 600, 3600, 86400];
    const nextIdx = (cycle.indexOf(cur) + 1) % cycle.length;
    const nextVal = cycle[nextIdx] ?? 0;
    await setConfig('auto_delete_seconds', String(nextVal));
    const opts = await getSettingsKeyboardOpts(lang);
    if (userLevel === 4) {
      opts.peEnabled = await isPremiumEmojiEnabled();
    }
    return editMarkup(chatId, messageId, buildSettingsKeyboard(lang, opts, userLevel));
  }

  if (data === ACTIONS.SETTINGS_BUNDLE_TTL) {
    await answerCq(cq);
    const cur = Number(await getConfig('bundle_ttl_hours', '0')) || 0;
    const cycle = [0, 24, 72, 168];
    const nextIdx = (cycle.indexOf(cur) + 1) % cycle.length;
    const nextVal = cycle[nextIdx] ?? 0;
    await setConfig('bundle_ttl_hours', String(nextVal));
    const opts = await getSettingsKeyboardOpts(lang);
    if (userLevel === 4) {
      opts.peEnabled = await isPremiumEmojiEnabled();
    }
    return editMarkup(chatId, messageId, buildSettingsKeyboard(lang, opts, userLevel));
  }

  if (data === ACTIONS.SETTINGS_CAP || data === ACTIONS.SETTINGS_DAILY_LIMIT) {
    const cur = Number(await getConfig('daily_download_cap', '0')) || 0;
    const presets = [0, 5, 10, 25, 50, 100];
    const nextIdx = (presets.indexOf(cur) + 1) % presets.length;
    const nextVal = presets[nextIdx] ?? 0;
    await setConfig('daily_download_cap', String(nextVal));
    await answerCq(cq);
    const opts = await getSettingsKeyboardOpts(lang);
    if (userLevel === 4) {
      opts.peEnabled = await isPremiumEmojiEnabled();
    }
    return editMarkup(chatId, messageId, buildSettingsKeyboard(lang, opts, userLevel));
  }

  if (data === ACTIONS.SETTINGS_LANG) {
    await answerCq(cq);
    const curL = (await getConfig('language')) || (await getConfig('default_lang', 'en')) || 'en';
    const nextL = curL === 'fa' ? 'en' : 'fa';
    await setConfig('language', nextL);
    await setConfig('default_lang', nextL);
    const opts = await getSettingsKeyboardOpts(nextL);
    if (userLevel === 4) {
      opts.peEnabled = await isPremiumEmojiEnabled();
    }
    return editMsg(chatId, messageId, t(nextL, 'settings_title'), { reply_markup: buildSettingsKeyboard(nextL, opts, userLevel) });
  }

  return false;
}

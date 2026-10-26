import {
  ACTIONS, tgApi, escapeHtml, getEffectiveOwnerId, getRoleLevel,
  sendMsg, editMsg, setAdminPrompt, clearAdminSession, answerCq
} from '../helpers.js';
import { t } from '../locales/index.js';

export function buildProfileKeyboard(lang) {
  return {
    inline_keyboard: [
      [{ text: `✏️ ${t(lang, 'profile_btn_change_name')}`, callback_data: ACTIONS.BOT_PROFILE_SET_NAME, style: 'primary' }],
      [{ text: `📝 ${t(lang, 'profile_btn_change_desc')}`, callback_data: ACTIONS.BOT_PROFILE_SET_DESC, style: 'primary' }],
      [{ text: `📄 ${t(lang, 'profile_btn_change_short_desc')}`, callback_data: ACTIONS.BOT_PROFILE_SET_SHORT_DESC, style: 'primary' }],
      [{ text: t(lang, 'profile_btn_change_photo'), callback_data: ACTIONS.BOT_PROFILE_SET_PHOTO, style: 'primary' }],
      [{ text: t(lang, 'profile_btn_remove_photo'), callback_data: ACTIONS.BOT_PROFILE_REMOVE_PHOTO, style: 'danger' }],
      [{ text: `🔙 ${t(lang, 'btn_back_settings')}`, callback_data: ACTIONS.SETTINGS_MENU }]
    ]
  };
}

export const buildBotProfileKeyboard = buildProfileKeyboard;

export async function renderBotProfileMenu(chatId, messageId = null, lang = 'en', api = tgApi, _db = null) {
  const client = (api && typeof api.getMyName === 'function') ? api : tgApi;
  let botName = '';
  let botDesc = '';
  let botShortDesc = '';
  try {
    const [nameRes, descRes, shortRes] = await Promise.all([
      client.getMyName({}).catch(() => null),
      client.getMyDescription({}).catch(() => null),
      client.getMyShortDescription({}).catch(() => null),
    ]);
    botName = nameRes?.name || '';
    botDesc = descRes?.description || '';
    botShortDesc = shortRes?.short_description || '';
  } catch (_) {}

  if (!botName) {
    try {
      const me = await client.getMe({}).catch(() => null);
      if (me?.first_name) botName = me.first_name;
    } catch (_) {}
  }

  let text = `<blockquote>${t(lang, 'profile_menu_title')}</blockquote>`;
  const infoLines = [];
  if (botName) infoLines.push(`🏷 <b>${escapeHtml(botName)}</b>`);
  if (botShortDesc) infoLines.push(`ℹ️ <i>${escapeHtml(botShortDesc)}</i>`);
  if (botDesc) infoLines.push(`\n<pre>${escapeHtml(botDesc)}</pre>`);
  if (infoLines.length > 0) {
    text += `\n\n${infoLines.join('\n')}`;
  }

  const reply_markup = buildProfileKeyboard(lang);

  if (messageId) {
    return editMsg(chatId, messageId, text, { reply_markup });
  }
  return sendMsg(chatId, text, { reply_markup });
}

export async function handleProfileCallback(data, cq, userId, chatId, messageId, lang = 'en', role = 'user', _ctx = null) {
  if (data !== ACTIONS.BOT_PROFILE_MENU &&
      data !== 'bprof:menu' &&
      data !== ACTIONS.BOT_PROFILE_SET_NAME &&
      data !== 'bprof:name' &&
      data !== ACTIONS.BOT_PROFILE_SET_DESC &&
      data !== 'bprof:desc' &&
      data !== ACTIONS.BOT_PROFILE_SET_SHORT_DESC &&
      data !== 'bprof:short' &&
      data !== ACTIONS.BOT_PROFILE_SET_PHOTO &&
      data !== 'bprof:photo' &&
      data !== ACTIONS.BOT_PROFILE_REMOVE_PHOTO &&
      data !== 'bprof:rmphoto' &&
      data !== ACTIONS.BOT_PROFILE_REMOVE_PHOTO_CONFIRM &&
      data !== 'bprof:rmphoto_confirm' &&
      data !== ACTIONS.BOT_PROFILE_CANCEL &&
      data !== 'bprof:cancel') {
    return false;
  }

  const ownerId = await getEffectiveOwnerId();
  const isOwner = (userId && ownerId && Number(userId) === Number(ownerId)) || role === 'owner';
  const effectiveUserLevel = isOwner ? 4 : getRoleLevel(role);

  if (effectiveUserLevel < 3) {
    if (cq) {
      await answerCq(cq, t(lang, 'superadmin_only_command'), true);
    }
    return false;
  }

  if (data === ACTIONS.BOT_PROFILE_MENU || data === 'bprof:menu') {
    if (cq) await answerCq(cq);
    return renderBotProfileMenu(chatId, messageId, lang);
  }

  if (data === ACTIONS.BOT_PROFILE_SET_NAME || data === 'bprof:name') {
    await setAdminPrompt(userId, 'profile', 'bprof_waiting_name');
    if (cq) await answerCq(cq);
    const promptText = `${t(lang, 'profile_prompt_name')}\n\n💡 <i>${t(lang, 'profile_placeholder_name')}</i>`;
    return editMsg(chatId, messageId, promptText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: `❌ ${t(lang, 'profile_btn_cancel')}`, callback_data: ACTIONS.BOT_PROFILE_CANCEL, style: 'danger' }]
        ]
      }
    });
  }

  if (data === ACTIONS.BOT_PROFILE_SET_DESC || data === 'bprof:desc') {
    await setAdminPrompt(userId, 'profile', 'bprof_waiting_desc');
    if (cq) await answerCq(cq);
    const promptText = `${t(lang, 'profile_prompt_desc')}\n\n💡 <i>${t(lang, 'profile_placeholder_desc')}</i>`;
    return editMsg(chatId, messageId, promptText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: `❌ ${t(lang, 'profile_btn_cancel')}`, callback_data: ACTIONS.BOT_PROFILE_CANCEL, style: 'danger' }]
        ]
      }
    });
  }

  if (data === ACTIONS.BOT_PROFILE_SET_SHORT_DESC || data === 'bprof:short') {
    await setAdminPrompt(userId, 'profile', 'bprof_waiting_short');
    if (cq) await answerCq(cq);
    const promptText = `${t(lang, 'profile_prompt_short_desc')}\n\n💡 <i>${t(lang, 'profile_placeholder_short_desc')}</i>`;
    return editMsg(chatId, messageId, promptText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: `❌ ${t(lang, 'profile_btn_cancel')}`, callback_data: ACTIONS.BOT_PROFILE_CANCEL, style: 'danger' }]
        ]
      }
    });
  }

  if (data === ACTIONS.BOT_PROFILE_SET_PHOTO || data === 'bprof:photo') {
    await setAdminPrompt(userId, 'profile', 'bprof_waiting_photo');
    if (cq) await answerCq(cq);
    const promptText = t(lang, 'profile_prompt_new_photo');
    return editMsg(chatId, messageId, promptText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: `❌ ${t(lang, 'profile_btn_cancel')}`, callback_data: ACTIONS.BOT_PROFILE_CANCEL, style: 'danger' }]
        ]
      }
    });
  }

  if (data === ACTIONS.BOT_PROFILE_REMOVE_PHOTO || data === 'bprof:rmphoto') {
    if (cq) await answerCq(cq);
    return editMsg(chatId, messageId, t(lang, 'profile_confirm_rmphoto_title'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'profile_btn_confirm_rmphoto'), callback_data: ACTIONS.BOT_PROFILE_REMOVE_PHOTO_CONFIRM, style: 'danger' }],
          [{ text: `🔙 ${t(lang, 'btn_cancel')}`, callback_data: ACTIONS.BOT_PROFILE_MENU }]
        ]
      }
    });
  }

  if (data === ACTIONS.BOT_PROFILE_REMOVE_PHOTO_CONFIRM || data === 'bprof:rmphoto_confirm') {
    if (effectiveUserLevel < 3) {
      if (cq) await answerCq(cq, t(lang, 'superadmin_only_command'), true);
      return false;
    }
    const api = (_ctx?.api && typeof _ctx.api.removeMyProfilePhoto === 'function') ? _ctx.api : tgApi;
    try {
      if (typeof api.removeMyProfilePhoto === 'function') {
        await api.removeMyProfilePhoto({});
      }
    } catch (e1) {
      try {
        if (typeof api.removeMyProfilePhoto === 'function') {
          await api.removeMyProfilePhoto();
        }
      } catch (e2) {
        console.error('removeMyProfilePhoto failed:', e2?.description || e2?.message || e2);
      }
    }
    if (cq) await answerCq(cq, t(lang, 'profile_photo_removed'));
    return renderBotProfileMenu(chatId, messageId, lang, api);
  }

  if (data === ACTIONS.BOT_PROFILE_CANCEL || data === 'bprof:cancel') {
    await clearAdminSession(userId);
    if (cq) await answerCq(cq, t(lang, 'profile_op_cancelled'));
    return renderBotProfileMenu(chatId, messageId, lang);
  }

  return false;
}

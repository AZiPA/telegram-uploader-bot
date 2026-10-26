import { db, asc, forceChannels, sendMsg, editMsg, ACTIONS } from '../helpers.js';
import { t } from '../locales/index.js';

export function buildForceJoinUserKeyboard(lang, channels = [], code = '', verifyText = '') {
  const rows = channels.map((ch, idx) => [{
    text: ch.button_text || t(lang, 'fj_join_btn', { label: ch.channel_name || t(lang, 'fj_ordinal_fallback', { n: idx + 1 }) }),
    url: ch.invite_link
  }]);
  rows.push([{ text: verifyText || t(lang, 'btn_verify_join'), callback_data: `${ACTIONS.FORCE_JOIN_CHECK}${code}` }]);
  return { inline_keyboard: rows };
}

export const buildForceJoinKeyboard = buildForceJoinUserKeyboard;

export function buildForceJoinAdminKeyboard(lang, channels = []) {
  const rows = [];
  for (const ch of channels) {
    rows.push([{ text: `📢 ${ch.channel_name}`, callback_data: `${ACTIONS.FJ_STATS}${ch.channel_id}` }]);
    rows.push([
      { text: t(lang, 'fj_menu_edit_name'), callback_data: `${ACTIONS.FJ_EDIT_LABEL}${ch.channel_id}` },
      { text: t(lang, 'fj_menu_renew'), callback_data: `${ACTIONS.FJ_RENEW}${ch.channel_id}` },
      { text: t(lang, 'fj_menu_recheck'), callback_data: `${ACTIONS.FJ_RECHECK}${ch.channel_id}` },
      { text: t(lang, 'fj_menu_delete'), callback_data: `${ACTIONS.FJ_DELETE}${ch.channel_id}`, style: 'danger' }
    ]);
  }
  rows.push([{ text: t(lang, 'fj_menu_refresh'), callback_data: ACTIONS.FJ_MENU_REFRESH }]);
  return { inline_keyboard: rows };
}

export async function renderForceJoinAdminPanel(chatId, messageId, lang, edit = false) {
  const channels = await db.select().from(forceChannels).orderBy(asc(forceChannels.created_at)).all();
  const text = channels.length ? t(lang, 'fj_menu_title') : t(lang, 'fj_menu_empty');
  const replyMarkup = buildForceJoinAdminKeyboard(lang, channels);
  if (edit && messageId) {
    return editMsg(chatId, messageId, text, replyMarkup, true);
  }
  return sendMsg(chatId, text, replyMarkup);
}

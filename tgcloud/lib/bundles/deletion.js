import { ACTIONS, answerCq, editMsg, editMarkup, sendMsg } from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundleFresh, bundleMutationGuard } from './permissions.js';
import { deleteBundle } from './lifecycle.js';
import { renderHub } from './hub_panel.js';

export function buildDeleteConfirmKeyboard(lang, code) {
  return {
    inline_keyboard: [[
      { text: t(lang, 'delete_confirm_yes'), callback_data: `${ACTIONS.DELETE_CONFIRM_YES}${code}`, style: 'danger' },
      { text: t(lang, 'delete_confirm_no'), callback_data: `${ACTIONS.DELETE_CONFIRM_NO}${code}` }
    ]]
  };
}

export async function handleDeleteCommand(cmd, arg, chatId, userId, lang, role) {
  if (cmd === '/delete') {
    const code = (arg || '').trim();
    if (!code) return;
    const { row, allowed } = await getManagedBundleFresh(code, userId);
    if (!row || !allowed) return;
    return sendMsg(chatId, t(lang, 'hub_btn_delete_bundle'), buildDeleteConfirmKeyboard(lang, code));
  }
}

export async function handleDeleteCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.DELETE_CONFIRM_YES)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.DELETE_CONFIRM_YES.length);
    const { row, allowed } = await getManagedBundleFresh(code, userId);
    if (allowed) {
      // Disarm keyboard first
      await editMarkup(chatId, messageId, { inline_keyboard: [] });
      if (!await deleteBundle(row, bundleMutationGuard(userId))) return false;
      return editMsg(chatId, messageId, t(lang, 'bundle_deleted_msg'));
    }
    return false;
  }
  if (data.startsWith(ACTIONS.DELETE_CONFIRM_ASK)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.DELETE_CONFIRM_ASK.length);
    return editMarkup(chatId, messageId, buildDeleteConfirmKeyboard(lang, code));
  }
  if (data.startsWith(ACTIONS.DELETE_CONFIRM_NO)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.DELETE_CONFIRM_NO.length);
    return renderHub(chatId, messageId, code, lang, role, userId, true);
  }
  return false;
}

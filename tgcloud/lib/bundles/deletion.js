import { db } from 'sdk';
import { eq } from 'sdk/db';
import { bundles, bundleVotes } from '../../schema.js';
import { ACTIONS, answerCq, editMsg, editMarkup, sendMsg } from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundle } from './permissions.js';
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
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (!row || !allowed) return;
    return sendMsg(chatId, t(lang, 'hub_btn_delete_bundle'), buildDeleteConfirmKeyboard(lang, code));
  }
}

export async function handleDeleteCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.DELETE_CONFIRM_YES)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.DELETE_CONFIRM_YES.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
      // Disarm keyboard first
      await editMarkup(chatId, messageId, { inline_keyboard: [] });
      await db.delete(bundleVotes).where(eq(bundleVotes.code, code)).run();
      await db.delete(bundles).where(eq(bundles.code, code)).run();
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

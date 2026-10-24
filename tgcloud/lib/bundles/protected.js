import { db } from 'sdk';
import { eq } from 'sdk/db';
import { bundles } from '../../schema.js';
import {
  ACTIONS, answerCq, getRoleLevel
} from '../helpers.js';
import { getManagedBundle } from './permissions.js';
import { renderHub } from './hub_panel.js';

export async function handleProtectedCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.MAKE_PROTECTED)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.MAKE_PROTECTED.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
      await db.update(bundles).set({ protect_content: !row.protect_content }).where(eq(bundles.code, code)).run();
      return renderHub(chatId, messageId, code, lang, role, userId, true);
    }
    return false;
  }
  const isLockAction = data.startsWith(ACTIONS.LOCK_BUNDLE) || data.startsWith('b:lock:');
  if (isLockAction) {
    await answerCq(cq);
    const prefix = data.startsWith(ACTIONS.LOCK_BUNDLE) ? ACTIONS.LOCK_BUNDLE : 'b:lock:';
    const code = data.slice(prefix.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
      const userLevel = getRoleLevel(role);
      if (userLevel >= 3) {
        await db.update(bundles).set({ owner_locked: !row.owner_locked }).where(eq(bundles.code, code)).run();
      }
      return renderHub(chatId, messageId, code, lang, role, userId, true);
    }
    return false;
  }
  return false;
}

import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { bundles, bundleVotes, userDownloads } from '../../schema.js';
import {
  ACTIONS, answerCq, getRoleLevel, tgApi, generateBundleCode, getBotUsername
} from '../helpers.js';
import { buildChannelPostKeyboard } from '../shared/buttons.js';
import { getManagedBundleFresh, bundleMutationGuard } from './permissions.js';
import { bundleAvailable, ensureBundleIdentity } from './lifecycle.js';
import { renderHub } from './hub_panel.js';
import { rebindAdminSessions } from '../shared/sessions.js';

export async function handleProtectedCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.MAKE_PROTECTED)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.MAKE_PROTECTED.length);
    const access = await getManagedBundleFresh(code, userId);
    if (access.allowed) {
      const row = await ensureBundleIdentity(access.row);
      if (!row) return false;
      const nextState = !row.protect_content;
      let targetCode = code;

      if (nextState === true && row.code.length < 36) {
        let newCode = '';
        let updated = false;
        let attempts = 0;

        while (!updated && attempts < 3) {
          attempts++;
          newCode = generateBundleCode(true);
          try {
            const res = await db.update(bundles)
              .set({ protect_content: true, code: newCode })
              .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, row.upload_session_id), bundleAvailable(), bundleMutationGuard(userId)))
              .run();
            if ((res?.rowsAffected ?? 0) === 1) {
              updated = true;
              targetCode = newCode;
            } else return false;
          } catch (err) {
            const msg = String(err?.message || err?.description || err || '');
            if (msg.includes('UNIQUE') || msg.includes('constraint')) {
              continue;
            }
            throw err;
          }
        }

        if (updated) {
          try { await db.update(bundleVotes).set({ code: targetCode }).where(eq(bundleVotes.code, code)).run(); } catch (_) {}
          try { await db.update(userDownloads).set({ code: targetCode }).where(eq(userDownloads.code, code)).run(); } catch (_) {}
          try { await rebindAdminSessions(code, targetCode); } catch (_) {}

          if (row.post_channel_id && row.post_message_id) {
            try {
              const botUser = await getBotUsername();
              await tgApi.editMessageReplyMarkup({
                chat_id: row.post_channel_id,
                message_id: row.post_message_id,
                reply_markup: buildChannelPostKeyboard(lang, botUser, targetCode),
              });
            } catch (_) {}
          }
        }
      } else {
        const changed = await db.update(bundles).set({ protect_content: nextState })
          .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, row.upload_session_id), bundleAvailable(), bundleMutationGuard(userId))).run();
        if (changed.rowsAffected !== 1) return false;
      }

      return renderHub(chatId, messageId, targetCode, lang, role, userId, true);
    }
    return false;
  }

  const isLockAction = data.startsWith(ACTIONS.LOCK_BUNDLE) || data.startsWith('b:lock:');
  if (isLockAction) {
    await answerCq(cq);
    const prefix = data.startsWith(ACTIONS.LOCK_BUNDLE) ? ACTIONS.LOCK_BUNDLE : 'b:lock:';
    const code = data.slice(prefix.length);
    const access = await getManagedBundleFresh(code, userId);
    if (access.allowed) {
      const row = await ensureBundleIdentity(access.row);
      if (!row) return false;
      const userLevel = getRoleLevel(role);
      if (userLevel >= 3) {
        const changed = await db.update(bundles).set({ owner_locked: !row.owner_locked })
          .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, row.upload_session_id), bundleAvailable(), bundleMutationGuard(userId))).run();
        if (changed.rowsAffected !== 1) return false;
      }
      return renderHub(chatId, messageId, code, lang, role, userId, true);
    }
    return false;
  }
  return false;
}

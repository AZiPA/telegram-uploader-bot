import { db } from 'sdk';
import { eq } from 'sdk/db';
import { bundles, bundleVotes, userDownloads, adminSessions } from '../../schema.js';
import {
  ACTIONS, answerCq, getRoleLevel, tgApi, generateBundleCode, getBotUsername
} from '../helpers.js';
import { buildChannelPostKeyboard } from '../shared/buttons.js';
import { getManagedBundle } from './permissions.js';
import { renderHub } from './hub_panel.js';

export async function handleProtectedCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.MAKE_PROTECTED)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.MAKE_PROTECTED.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
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
              .where(eq(bundles.code, code))
              .run();
            if ((res?.rowsAffected ?? 0) === 1) {
              updated = true;
              targetCode = newCode;
            }
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
          try { await db.update(adminSessions).set({ code: targetCode }).where(eq(adminSessions.code, code)).run(); } catch (_) {}

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
        await db.update(bundles).set({ protect_content: nextState }).where(eq(bundles.code, code)).run();
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

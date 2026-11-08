import { db } from 'sdk';
import { eq, ne, and, or, sql, count, gt } from 'sdk/db';
import { bundles, bundleVotes, userDownloads } from '../../schema.js';
import {
  tgApi, ACTIONS, LIMITS, getConfig, getRoleLevel, escapeHtml,
  generateBundleCode, getBotUsername, sendMsg, answerCq, nowSec
} from '../helpers.js';
import { buildChannelPostKeyboard } from '../shared/buttons.js';
import { executeDelivery } from '../filestore/delivery.js';
import { t } from '../locales/index.js';
import { getManagedBundleFresh, bundleMutationGuard } from './permissions.js';
import { bundleAvailable, ensureBundleIdentity } from './lifecycle.js';
import { renderHub } from './hub_panel.js';
import { rebindAdminSessions } from '../shared/sessions.js';
import { createAdminTestOperation } from '../filestore/trusted_admin_test.js';

export async function handleRotationCommand(cmd, arg, message, userId, chatId, lang, role, ctx) {
  if (cmd === '/postbundle') {
    const [code, chArg] = (arg || '').split(/\s+/);
    const rawTarget = chArg || (await getConfig('pub_channel_id', null));
    const target = (rawTarget && rawTarget !== 'off' && rawTarget !== '0') ? rawTarget : null;
    if (!code) return sendMsg(chatId, t(lang, 'postbundle_usage'));
    const access = await getManagedBundleFresh(code, userId);
    const { allowed } = access;
    if (!target) return sendMsg(chatId, t(lang, 'pubchannel_not_set'));
    if (!access.row || !allowed) return;
    const row = await ensureBundleIdentity(access.row);
    if (!row) return;
    if (row.rotate_interval_sec > 0) {
      const chCountRes = await db.select({ c: count() })
        .from(bundles)
        .where(and(
          eq(bundles.post_channel_id, target),
          gt(bundles.rotate_interval_sec, 0),
          ne(bundles.code, code)
        ))
        .get();
      if ((chCountRes?.c || 0) >= LIMITS.MAX_ROTATING_PER_CHANNEL) {
        return sendMsg(chatId, `⚠️ Maximum rotating bundles per channel reached (${LIMITS.MAX_ROTATING_PER_CHANNEL}).`);
      }
    }
    const botUser = await getBotUsername();
    const res = await tgApi.sendMessage({
      chat_id: target,
      text: `📦 <b>${escapeHtml(row.title || 'Bundle')}</b>`,
      parse_mode: 'HTML',
      reply_markup: buildChannelPostKeyboard(lang, botUser, code),
    });
    if (res?.message_id) {
      const changed = await db.update(bundles).set({ post_channel_id: target, post_message_id: res.message_id })
        .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, row.upload_session_id), bundleAvailable(), bundleMutationGuard(userId))).run();
      if (changed.rowsAffected !== 1) return false;
      return sendMsg(chatId, t(lang, 'postbundle_success', { target: escapeHtml(target) }));
    }
  }
  if (cmd === '/rotatelink') {
    const [code, intArg] = (arg || '').split(/\s+/);
    if (!code) return sendMsg(chatId, t(lang, 'rotatelink_usage'));
    const access = await getManagedBundleFresh(code, userId);
    if (!access.row || !access.allowed) return;
    const row = await ensureBundleIdentity(access.row);
    if (!row) return;
    if (intArg) {
      const hours = Number(intArg) || 0;
      const intervalSec = hours * 3600;
      if (intervalSec > 0 && (!row.rotate_interval_sec || row.rotate_interval_sec === 0)) {
        const userLevel = getRoleLevel(role);
        if (userLevel < 4) {
          const maxLimit = userLevel === 3 ? LIMITS.MAX_ROTATING_SUPERADMIN : LIMITS.MAX_ROTATING_ADMIN;
          const countRes = await db.select({ c: count() })
            .from(bundles)
            .where(and(
              eq(bundles.created_by, Number(userId)),
              gt(bundles.rotate_interval_sec, 0)
            ))
            .get();
          if ((countRes?.c || 0) >= maxLimit) {
            return sendMsg(chatId, `⚠️ Maximum rotating bundles reached (${maxLimit}).`);
          }
        }
        if (row.post_channel_id) {
          const chRes = await db.select({ c: count() })
            .from(bundles)
            .where(and(
              eq(bundles.post_channel_id, row.post_channel_id),
              gt(bundles.rotate_interval_sec, 0)
            ))
            .get();
          if ((chRes?.c || 0) >= LIMITS.MAX_ROTATING_PER_CHANNEL) {
            return sendMsg(chatId, `⚠️ Maximum rotating bundles per channel reached (${LIMITS.MAX_ROTATING_PER_CHANNEL}).`);
          }
        }
      }
      const updateData = { rotate_interval_sec: intervalSec };
      if (intervalSec > 0) {
        updateData.last_rotated_at = nowSec();
      }
      const changed = await db.update(bundles).set(updateData)
        .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, row.upload_session_id), bundleAvailable(), bundleMutationGuard(userId))).run();
      if (changed.rowsAffected !== 1) return false;
      return sendMsg(chatId, t(lang, 'rotate_interval_updated', { val: `${hours}h` }));
    }
    const now = nowSec();
    const isProtected = Boolean(row.protect_content || row.is_protected);
    let newCode = '';
    let rotated = false;
    let attempts = 0;

    while (!rotated && attempts < 3) {
      attempts++;
      newCode = generateBundleCode(isProtected);
      try {
        const res = await db.update(bundles)
          .set({ code: newCode, last_rotated_at: now })
          .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, row.upload_session_id), bundleAvailable(), bundleMutationGuard(userId)))
          .run();
        if ((res?.rowsAffected ?? 0) === 1) {
          rotated = true;
        } else {
          return { rotated: false };
        }
      } catch (err) {
        const msg = String(err?.message || err?.description || err || '');
        if (msg.includes('UNIQUE') || msg.includes('constraint')) {
          continue;
        }
        throw err;
      }
    }

    if (!rotated) {
      throw new Error('Failed to allocate unique bundle code after 3 attempts');
    }
    try { await db.update(bundleVotes).set({ code: newCode }).where(eq(bundleVotes.code, code)).run(); } catch (_) {}
    try { await db.update(userDownloads).set({ code: newCode }).where(eq(userDownloads.code, code)).run(); } catch (_) {}
    await rebindAdminSessions(code, newCode);
    const botUser = await getBotUsername();
    if (row.post_channel_id && row.post_message_id) {
      await tgApi.editMessageReplyMarkup({
        chat_id: row.post_channel_id,
        message_id: row.post_message_id,
        reply_markup: buildChannelPostKeyboard(lang, botUser, newCode),
      }).catch(() => {});
    }
    await sendMsg(chatId, t(lang, 'rotatelink_success', { link: `https://t.me/${botUser}?start=${escapeHtml(newCode)}` }));
    return { rotated: true, code: newCode };
  }
}

export async function handleRotationCallback(data, cq, userId, chatId, messageId, lang, role, ctx) {
  if (data.startsWith('mng:testdl:')) {
    const code = data.slice('mng:testdl:'.length);
    await answerCq(cq);
    const operation = await createAdminTestOperation(userId, chatId, code);
    if (!operation) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    return executeDelivery(chatId, userId, code, lang, ctx, 0, operation.operation_id);
  }
  if (data.startsWith(ACTIONS.BUNDLE_ROTATE_INT)) {
    const code = data.slice(ACTIONS.BUNDLE_ROTATE_INT.length);
    const access = await getManagedBundleFresh(code, userId);
    if (access.allowed) {
      const row = await ensureBundleIdentity(access.row);
      if (!row) return false;
      const nextRot = row.rotate_interval_sec === 0 ? 3600 : (row.rotate_interval_sec === 3600 ? 21600 : 0);
      if (nextRot > 0 && (!row.rotate_interval_sec || row.rotate_interval_sec === 0)) {
        const userLevel = getRoleLevel(role);
        if (userLevel < 4) {
          const maxLimit = userLevel === 3 ? LIMITS.MAX_ROTATING_SUPERADMIN : LIMITS.MAX_ROTATING_ADMIN;
          const countRes = await db.select({ c: count() })
            .from(bundles)
            .where(and(
              eq(bundles.created_by, Number(userId)),
              gt(bundles.rotate_interval_sec, 0)
            ))
            .get();
          if ((countRes?.c || 0) >= maxLimit) {
            return answerCq(cq, `Maximum rotating bundles reached (${maxLimit})`, true);
          }
        }
        if (row.post_channel_id) {
          const chRes = await db.select({ c: count() })
            .from(bundles)
            .where(and(
              eq(bundles.post_channel_id, row.post_channel_id),
              gt(bundles.rotate_interval_sec, 0)
            ))
            .get();
          if ((chRes?.c || 0) >= LIMITS.MAX_ROTATING_PER_CHANNEL) {
            return answerCq(cq, `Maximum rotating bundles per channel reached (${LIMITS.MAX_ROTATING_PER_CHANNEL})`, true);
          }
        }
      }
      const updateData = { rotate_interval_sec: nextRot };
      if (nextRot > 0) {
        updateData.last_rotated_at = nowSec();
      }
      const changed = await db.update(bundles).set(updateData)
        .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, row.upload_session_id), bundleAvailable(), bundleMutationGuard(userId))).run();
      if (changed.rowsAffected !== 1) return false;
      await answerCq(cq);
      return renderHub(chatId, messageId, code, lang, role, userId, true);
    }
  }
  if (data.startsWith(ACTIONS.BUNDLE_ROTATE_NOW)) {
    await answerCq(cq);
    const c = data.slice(ACTIONS.BUNDLE_ROTATE_NOW.length);
    const mockMsg = { from: { id: userId }, chat: { id: chatId } };
    const res = await handleRotationCommand('/rotatelink', c, mockMsg, userId, chatId, lang, role, ctx);
    const targetCode = (res && res.rotated && res.code) ? res.code : c;
    return renderHub(chatId, messageId, targetCode, lang, role, userId, true);
  }
  if (data.startsWith(ACTIONS.BUNDLE_POST_CHANNEL)) {
    await answerCq(cq);
    const c = data.slice(ACTIONS.BUNDLE_POST_CHANNEL.length);
    const p = await getConfig('pub_channel_id', null);
    if (!p) {
      return sendMsg(chatId, t(lang, 'pubchannel_not_set'));
    }
    const mockMsg = { from: { id: userId }, chat: { id: chatId } };
    await handleRotationCommand('/postbundle', `${c} ${p}`, mockMsg, userId, chatId, lang, role, ctx);
    return renderHub(chatId, messageId, c, lang, role, userId, true);
  }
}

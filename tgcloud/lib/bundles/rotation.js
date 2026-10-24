import { db } from 'sdk';
import { eq, ne, and, or, sql, count, gt } from 'sdk/db';
import { bundles, bundleVotes, userDownloads, userSessions, adminSessions } from '../../schema.js';
import {
  tgApi, ACTIONS, LIMITS, getConfig, getRoleLevel, escapeHtml,
  generateBundleCode, getBotUsername, sendMsg, answerCq, nowSec, getBundle
} from '../helpers.js';
import { buildChannelPostKeyboard } from '../shared/buttons.js';
import { executeDelivery } from '../filestore/delivery.js';
import { t } from '../locales/index.js';
import { getManagedBundle, canManageBundle } from './permissions.js';
import { renderHub } from './hub_panel.js';

export async function handleRotationCommand(cmd, arg, message, userId, chatId, lang, role, ctx) {
  if (cmd === '/postbundle') {
    const [code, chArg] = (arg || '').split(/\s+/);
    const rawTarget = chArg || (await getConfig('pub_channel_id', null));
    const target = (rawTarget && rawTarget !== 'off' && rawTarget !== '0') ? rawTarget : null;
    if (!code) return sendMsg(chatId, t(lang, 'postbundle_usage'));
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (!target) return sendMsg(chatId, t(lang, 'pubchannel_not_set'));
    if (!row || !allowed) return;
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
      await db.update(bundles).set({ post_channel_id: target, post_message_id: res.message_id }).where(eq(bundles.code, code)).run();
      return sendMsg(chatId, t(lang, 'postbundle_success', { target: escapeHtml(target) }));
    }
  }
  if (cmd === '/rotatelink') {
    const [code, intArg] = (arg || '').split(/\s+/);
    if (!code) return sendMsg(chatId, t(lang, 'rotatelink_usage'));
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (!row || !allowed) return;
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
      await db.update(bundles).set(updateData).where(eq(bundles.code, code)).run();
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
          .where(eq(bundles.code, code))
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
    await db.update(bundleVotes).set({ code: newCode }).where(eq(bundleVotes.code, code)).run();
    await db.update(userDownloads).set({ code: newCode }).where(eq(userDownloads.code, code)).run();
    await db.update(userSessions).set({ code: newCode }).where(eq(userSessions.code, code)).run();
    await db.update(adminSessions).set({ code: newCode }).where(eq(adminSessions.code, code)).run();
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
    const userLevel = getRoleLevel(role);
    if (userLevel < 2) {
      return answerCq(cq, t(lang, 'bundle_access_denied'), true);
    }
    const row = await getBundle(code);
    if (!row) {
      return answerCq(cq, t(lang, 'bundle_not_found'), true);
    }
    const allowed = await canManageBundle(role, userId, row);
    if (!allowed) {
      return answerCq(cq, t(lang, 'bundle_access_denied'), true);
    }
    await answerCq(cq);
    return executeDelivery(chatId, userId, code, lang, ctx, 0, undefined, true);
  }
  if (data.startsWith(ACTIONS.BUNDLE_ROTATE_INT)) {
    const code = data.slice(ACTIONS.BUNDLE_ROTATE_INT.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
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
      await db.update(bundles).set(updateData).where(eq(bundles.code, code)).run();
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

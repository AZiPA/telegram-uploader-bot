import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { adminSessions, bundles } from '../../schema.js';
import {
  ACTIONS, LIMITS, escapeHtml, truncateText,
  sendMsg, editMsg, answerCq, parseItems, nowSec, getBundle
} from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundle } from './permissions.js';

export function buildReviewKeyboard(lang, code, items = []) {
  const rows = [];
  let curr = [];
  const maxItems = Math.min(items.length, 25);
  for (let idx = 0; idx < maxItems; idx++) {
    const it = items[idx];
    curr.push({
      text: `🗑️ ${idx + 1}`,
      callback_data: `${ACTIONS.MANAGE_DEL_ITEM}${idx}:${(it.file_unique_id || 'item').slice(0, 8)}:${code}`,
      style: 'danger',
    });
    if (curr.length === 5) { rows.push(curr); curr = []; }
  }
  if (curr.length > 0) rows.push(curr);

  rows.push([
    { text: t(lang, 'review_refresh_btn'), callback_data: `${ACTIONS.MANAGE_REFRESH}${code}` },
    { text: t(lang, 'hub_btn_delete_bundle'), callback_data: `${ACTIONS.DELETE_CONFIRM_ASK}${code}`, style: 'danger' }
  ]);
  rows.push([{ text: t(lang, 'btn_back_to_hub'), callback_data: `${ACTIONS.MANAGE_HUB}${code}` }]);
  return { inline_keyboard: rows };
}

export async function renderReview(chatId, messageId, code, lang, role, userId, edit = false) {
  if (typeof messageId === 'string') {
    const legacyCode = messageId;
    const legacyLang = code;
    const legacyEditId = lang;
    code = legacyCode;
    lang = legacyLang;
    messageId = legacyEditId || null;
    edit = Boolean(messageId);
  }
  const row = await getBundle(code);
  if (!row) return sendMsg(chatId, t(lang, 'bundle_not_found'));

  if (userId) {
    const adminId = Number(userId);
    const now = nowSec();
    const serializedItems = typeof row.items === 'string' ? row.items : JSON.stringify(row.items || []);
    await db.insert(adminSessions).values({
      admin_id: adminId,
      code: row.code,
      mode: 'edit',
      items: serializedItems,
      updated_at: now,
    }).onConflictDoUpdate({
      target: adminSessions.admin_id,
      set: {
        code: row.code,
        mode: 'edit',
        items: serializedItems,
        updated_at: now,
      },
    }).run();
  }

  const items = parseItems(row.items);
  const kb = buildReviewKeyboard(lang, code, items);
  let itemList = '';
  if (items.length > 0) {
    itemList = items.map((it, idx) => {
      const typeIcon = it.type === 'video' ? '🎬' : it.type === 'photo' ? '🖼️' : it.type === 'audio' ? '🎵' : '📄';
      const rawName = it.file_name ? String(it.file_name).slice(0, 30) : (it.caption ? String(it.caption).slice(0, 30) : `${it.type || 'file'} ${idx + 1}`);
      return `${idx + 1}. ${typeIcon} <b>${escapeHtml(rawName)}</b> — /del_${idx + 1}`;
    }).join('\n') + '\n';
  }
  const text = t(lang, 'review_header', { code: escapeHtml(code) }) +
    t(lang, 'review_count', { count: items.length, max: LIMITS.MAX_BUNDLE_ITEMS }) +
    itemList +
    t(lang, 'review_delete_hint');
  const truncated = truncateText(text, 4096);
  if (edit && messageId) {
    return editMsg(chatId, messageId, truncated, kb, true);
  }
  return sendMsg(chatId, truncated, kb);
}

export async function handleReviewCommand(cmd, arg, chatId, userId, lang, role) {
  if (cmd === '/review') {
    if (!arg) return sendMsg(chatId, t(lang, 'review_usage'));
    const { row, allowed } = await getManagedBundle(arg, role, userId);
    if (!row || !allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    return renderReview(chatId, null, arg, lang, role, userId, false);
  }
  if (cmd.startsWith('/del_')) {
    const idx = Number(cmd.slice(5)) - 1;
    const now = nowSec();
    const s = await db.select().from(adminSessions).where(and(eq(adminSessions.admin_id, Number(userId)), eq(adminSessions.mode, 'edit'))).get();
    if (s && (now - (s.updated_at || 0) > 600)) {
      await db.delete(adminSessions).where(eq(adminSessions.admin_id, Number(userId))).run();
      return sendMsg(chatId, t(lang, 'operation_cancelled'));
    }
    if (s && idx >= 0) {
      const items = parseItems(s.items);
      if (items[idx]) {
        items.splice(idx, 1);
        items.sort((a, b) => {
          const sA = Number(a.source_message_id || 0);
          const sB = Number(b.source_message_id || 0);
          if (sA > 0 && sB > 0) return sA - sB;
          return 0;
        });
        const b = await db.select({ items: bundles.items }).from(bundles).where(eq(bundles.code, s.code)).get();
        if (b) {
          const casRes = await db.update(bundles)
            .set({ items })
            .where(and(eq(bundles.code, s.code), eq(bundles.items, b.items)))
            .run();
          const affected = casRes?.rowsAffected ?? 0;
          if (affected !== 1) {
            return sendMsg(chatId, t(lang, 'bundle_save_error'));
          }
        }
        await db.update(adminSessions)
          .set({ items: typeof items === 'string' ? items : JSON.stringify(items), updated_at: now })
          .where(eq(adminSessions.admin_id, Number(userId)))
          .run();
        return renderReview(chatId, null, s.code, lang, role, userId, false);
      }
    }
  }
}

export async function handleReviewCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith('mng:review:')) {
    await answerCq(cq);
    const code = data.slice('mng:review:'.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) return renderReview(chatId, messageId, code, lang, role, userId, true);
  }
  if (data.startsWith(ACTIONS.MANAGE_REFRESH)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.MANAGE_REFRESH.length);
    return renderReview(chatId, messageId, code, lang, role, userId, true);
  }
  if (data.startsWith(ACTIONS.MANAGE_DEL_ITEM)) {
    const [, , idxStr, , code] = data.split(':');
    const idx = Number(idxStr);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (row && allowed) {
      const items = parseItems(row.items);
      if (items[idx]) {
        items.splice(idx, 1);
        items.sort((a, b) => {
          const sA = Number(a.source_message_id || 0);
          const sB = Number(b.source_message_id || 0);
          if (sA > 0 && sB > 0) return sA - sB;
          return 0;
        });
        const casRes = await db.update(bundles)
          .set({ items })
          .where(and(eq(bundles.code, code), eq(bundles.items, row.items)))
          .run();
        const affected = casRes?.rowsAffected ?? 0;
        if (affected !== 1) {
          return answerCq(cq, t(lang, 'bundle_save_error'), true);
        }
        return renderReview(chatId, messageId, code, lang, role, userId, true);
      }
    }
  }
}

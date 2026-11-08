import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { bundles, uploadSessions } from '../../schema.js';
import {
  ACTIONS, LIMITS, escapeHtml, truncateText,
  sendMsg, editMsg, answerCq, parseItems, nowSec
} from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundleFresh, bundleMutationGuard } from './permissions.js';
import { clearExpiredAdminSession, getAdminSession, updateAdminSession, sessionIdentityActive } from '../shared/sessions.js';
import { sortUploadItems, startEditSession, getUploadOperation } from '../filestore/upload_state.js';
import { recoverBundleMirrorReceipts } from '../filestore/upload_mirror.js';
import { ensureBundleIdentity } from './lifecycle.js';

async function recoverReviewReceipts(bundle) {
  try { await recoverBundleMirrorReceipts(bundle.upload_session_id); } catch (error) {
    console.warn('Optional mirror receipt projection deferred:', error?.message || error);
  }
}

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
  let { row, allowed } = await getManagedBundleFresh(code, userId);
  if (!row || !allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));

  if (userId) {
    const adminId = Number(userId);
    const existingSess = await getAdminSession(adminId);
    const uploading = existingSess?.state === 'active' && ['batch', 'upload'].includes(existingSess.mode);
    const operation = uploading && existingSess.session_id
      ? await db.select().from(uploadSessions).where(eq(uploadSessions.id, existingSess.session_id)).get() : null;
    const isMidUpload = uploading && (!operation || operation.state === 'open');
    const editingSame = existingSess?.state === 'active' && existingSess.mode === 'edit' && existingSess.code === code;
    if (!isMidUpload && !editingSame) {
      const freshAccess = await getManagedBundleFresh(code, userId);
      if (!freshAccess.allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
      row = freshAccess.row;
      const replaced = await startEditSession(adminId, row, existingSess);
      if (!replaced) return sendMsg(chatId, t(lang, 'operation_cancelled'));
    }
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
    const { row, allowed } = await getManagedBundleFresh(arg, userId);
    if (!row || !allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    return renderReview(chatId, null, arg, lang, role, userId, false);
  }
  if (cmd.startsWith('/del_')) {
    const idx = Number(cmd.slice(5)) - 1;
    const now = nowSec();
    let s = await getAdminSession(userId);
    if (!s || s.mode !== 'edit' || s.state !== 'active') return sendMsg(chatId, t(lang, 'operation_cancelled'));
    if (s && (now - (s.updated_at || 0) > 600)) {
      const expired = await clearExpiredAdminSession(s, now - 600);
      if (expired.rowsAffected === 1) return sendMsg(chatId, t(lang, 'operation_cancelled'));
    }
    if (Number.isInteger(idx) && idx >= 0 && idx < LIMITS.MAX_BUNDLE_ITEMS) {
      const access = await getManagedBundleFresh(s.code, userId);
      if (!access.allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
      if (!s.session_id || !s.generation) {
        s = await updateAdminSession(s, { session_id: crypto.randomUUID(), generation: crypto.randomUUID() });
        if (!s) return sendMsg(chatId, t(lang, 'operation_cancelled'));
      }
      let operation;
      try { operation = await getUploadOperation(s); } catch (error) {
        if (!['UPLOAD_SESSION_CHANGED', 'UPLOAD_ACCESS_DENIED'].includes(error?.message)) throw error;
        return sendMsg(chatId, t(lang, 'operation_cancelled'));
      }
      if (access.row.upload_session_id && access.row.upload_session_id !== operation.bundle_id) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
      await recoverReviewReceipts(access.row);
      for (let attempt = 0; attempt < 4; attempt++) {
        const { row: b, allowed } = await getManagedBundleFresh(s.code, userId);
        if (!b || !allowed || b.upload_session_id !== operation.bundle_id) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
        const current = parseItems(b.items);
        if (!current[idx]) {
          return sendMsg(chatId, t(lang, 'review_stale_list'));
        }
        const next = sortUploadItems(current.filter((_, i) => i !== idx));
        const casRes = await db.update(bundles)
          .set({ items: next, removed_item_ids: removedItems(b, current[idx]) })
          .where(and(eq(bundles.code, s.code), eq(bundles.upload_session_id, operation.bundle_id), eq(bundles.items, b.items),
            eq(bundles.removed_item_ids, b.removed_item_ids), bundleMutationGuard(userId), sessionIdentityActive(s)))
          .run();
        const affected = casRes?.rowsAffected ?? 0;
        if (affected === 1) {
          await updateAdminSession(s, { items: next });
          return renderReview(chatId, null, s.code, lang, role, userId, false);
        }
      }
      return sendMsg(chatId, t(lang, 'bundle_save_error'));
    }
  }
}

export async function handleReviewCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith('mng:review:')) {
    await answerCq(cq);
    const code = data.slice('mng:review:'.length);
    const { allowed } = await getManagedBundleFresh(code, userId);
    if (allowed) return renderReview(chatId, messageId, code, lang, role, userId, true);
  }
  if (data.startsWith(ACTIONS.MANAGE_REFRESH)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.MANAGE_REFRESH.length);
    return renderReview(chatId, messageId, code, lang, role, userId, true);
  }
  if (data.startsWith(ACTIONS.MANAGE_DEL_ITEM)) {
    await answerCq(cq);
    const [, , idxStr, uid, code] = data.split(':');
    const idx = Number(idxStr);
    if (!/^\d+$/.test(idxStr || '') || !Number.isInteger(idx) || idx < 0 || idx >= LIMITS.MAX_BUNDLE_ITEMS) return true;
    let { row, allowed } = await getManagedBundleFresh(code, userId);
    if (row && allowed) {
      row = await ensureBundleIdentity(row);
      if (!row) return sendMsg(chatId, t(lang, 'operation_cancelled'));
      const bundleId = row.upload_session_id;
      await recoverReviewReceipts(row);
      ({ row, allowed } = await getManagedBundleFresh(code, userId));
      if (!row || !allowed || row.upload_session_id !== bundleId) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
      const items = parseItems(row.items);
      if (!items[idx] || (items[idx].file_unique_id || 'item').slice(0, 8) !== uid) {
        await sendMsg(chatId, t(lang, 'review_stale_list'));
        return renderReview(chatId, messageId, code, lang, role, userId, true);
      }
      const next = sortUploadItems(items.filter((_, i) => i !== idx));
      const casRes = await db.update(bundles)
        .set({ items: next, removed_item_ids: removedItems(row, items[idx]) })
        .where(and(eq(bundles.code, code), eq(bundles.upload_session_id, bundleId), eq(bundles.items, row.items),
          eq(bundles.removed_item_ids, row.removed_item_ids), bundleMutationGuard(userId)))
        .run();
      const affected = casRes?.rowsAffected ?? 0;
      if (affected !== 1) {
        return sendMsg(chatId, t(lang, 'bundle_save_error'));
      }
      return renderReview(chatId, messageId, code, lang, role, userId, true);
    }
  }
}

function removedItems(bundle, removed) {
  const existing = parseItems(bundle.removed_item_ids);
  return removed.item_id ? [...new Set([...existing, removed.item_id])] : existing;
}

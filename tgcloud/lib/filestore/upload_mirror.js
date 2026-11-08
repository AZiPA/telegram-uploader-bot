import { db } from 'sdk';
import { eq, and, inArray } from 'sdk/db';
import { bundles, uploadSessions, uploadItems } from '../../schema.js';
import { getStorageSnapshot, disableStorageSnapshot, parseItems } from '../shared/config.js';
import { tgApi, sendMsg } from '../shared/telegram.js';
import { escapeHtml } from '../shared/formatters.js';
import { copyMediaToStorage } from '../services/storage_channel.js';
import { sendLogAlert } from '../services/log_channel.js';
import { bundleAvailable } from '../bundles/lifecycle.js';
import { t } from '../locales/index.js';

const MIRROR_CAS_ATTEMPTS = 4;
function validReceipt(receipt, operation) {
  if (receipt?.kind !== 'item' || receipt.state !== 'accepted' || receipt.mirror_state !== 'confirmed'
    || !receipt.id || receipt.item?.item_id !== receipt.id
    || !Number.isSafeInteger(receipt.storage_message_id) || receipt.storage_message_id <= 0
    || !receipt.storage_channel_id || !Number.isSafeInteger(receipt.source_chat_id)
    || !Number.isSafeInteger(receipt.source_message_id) || receipt.source_message_id <= 0
    || receipt.item.source_chat_id !== receipt.source_chat_id
    || receipt.item.source_message_id !== receipt.source_message_id
    || !operation || operation.id !== receipt.session_id || operation.admin_id !== receipt.admin_id
    || !operation.generation || !['upload', 'batch', 'edit'].includes(operation.mode)
    || (operation.mode === 'edit' && !operation.bundle_id)) return false;
  try {
    const snapshot = JSON.parse(receipt.mirror_snapshot);
    return snapshot?.enabled === true && snapshot.channel_id === receipt.storage_channel_id
      && typeof snapshot.generation === 'string' && Boolean(snapshot.generation);
  } catch (_) { return false; }
}

function matchesReceipt(item, receipt) {
  return item.item_id === receipt.id && item.source_chat_id === receipt.source_chat_id
    && item.source_message_id === receipt.source_message_id && item.type === receipt.item.type;
}

async function warnMirror(userId, lang, receiptFailure, error) {
  // Each optional effect has its own awaited failure boundary. A missing log
  // channel never prevents a protected direct warning to the initiating admin.
  try {
    await sendMsg(userId, t(lang, receiptFailure ? 'storage_mirror_receipt_warning' : 'storage_mirror_warning'), null,
      { protect_content: true });
  } catch (_) {}
  try {
    const description = String(error?.description || error?.message || 'Optional mirror unavailable').slice(0, 600);
    await sendLogAlert('Mirroring Error', `${t(lang, 'storage_mirror_error')}\n${escapeHtml(description)}`, tgApi, db);
  } catch (_) {}
}

function mergeReceipts(items, receipts, retired = []) {
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  let changed = false;
  const next = items.map((item) => {
    const receipt = byId.get(item.item_id);
    if (!receipt || !matchesReceipt(item, receipt) || retired.includes(item.item_id)) return item;
    if (item.storage_message_id === receipt.storage_message_id && item.storage_channel_id === receipt.storage_channel_id) return item;
    changed = true;
    return { ...item, storage_message_id: receipt.storage_message_id, storage_channel_id: receipt.storage_channel_id };
  });
  return { next, changed };
}

// A durable confirmed receipt is written before either projection. The
// finalizer calls this again after INSERT, closing the session/bundle handoff.
export async function projectMirrorReceipts(sessionId) {
  let operation = await db.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).get();
  if (!operation || operation.state === 'deleted') return { attached: false };
  const receipts = (await db.select().from(uploadItems).where(and(
    eq(uploadItems.session_id, sessionId), eq(uploadItems.mirror_state, 'confirmed'),
    eq(uploadItems.state, 'accepted'), eq(uploadItems.kind, 'item'),
  )).all()).filter((receipt) => validReceipt(receipt, operation));
  if (!receipts.length) return { attached: false };
  let sessionProjected = false;
  for (let attempt = 0; attempt < MIRROR_CAS_ATTEMPTS; attempt++) {
    operation = await db.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).get();
    if (!operation || operation.state === 'deleted') return { attached: false };
    if (operation.mode === 'edit') break;
    const merged = mergeReceipts(parseItems(operation.items), receipts);
    if (!merged.changed) { sessionProjected = true; break; }
    const changed = await db.update(uploadSessions).set({ items: merged.next, revision: operation.revision + 1 })
      .where(and(eq(uploadSessions.id, operation.id), eq(uploadSessions.revision, operation.revision),
        eq(uploadSessions.generation, operation.generation), eq(uploadSessions.mode, operation.mode),
        eq(uploadSessions.bundle_code, operation.bundle_code), eq(uploadSessions.state, operation.state))).run();
    if (changed.rowsAffected === 1) { sessionProjected = true; break; }
  }
  if (!operation) return { attached: false };
  if (operation.mode !== 'edit' && !sessionProjected) throw new Error('MIRROR_SESSION_CONTENTION');
  const bundleId = operation.mode === 'edit' ? operation.bundle_id : operation.id;
  if (!bundleId) return { attached: sessionProjected };
  for (let attempt = 0; attempt < MIRROR_CAS_ATTEMPTS; attempt++) {
    const bundle = await db.select().from(bundles).where(and(
      eq(bundles.upload_session_id, bundleId), bundleAvailable(),
    )).get();
    if (!bundle) return { attached: sessionProjected };
    const retired = parseItems(bundle.removed_item_ids);
    const merged = mergeReceipts(parseItems(bundle.items), receipts, retired);
    if (!merged.changed) return { attached: true };
    // This repairs metadata for an already accepted exact item. The original
    // uploader's later revocation cannot invalidate a confirmed copy receipt.
    const changed = await db.update(bundles).set({ items: merged.next }).where(and(
      eq(bundles.code, bundle.code), eq(bundles.upload_session_id, bundleId),
      eq(bundles.items, bundle.items), eq(bundles.removed_item_ids, bundle.removed_item_ids),
      bundleAvailable(),
    )).run();
    if (changed.rowsAffected === 1) return { attached: true };
  }
  throw new Error('MIRROR_BUNDLE_CONTENTION');
}

// A later mutation may belong to a different edit operation. Find only the
// current item's confirmed ledger entries, then recover their original
// operations. The bundle's stable identity fences code rotation and reuse.
export async function recoverBundleMirrorReceipts(bundleId) {
  if (!bundleId) return { attached: false };
  const bundle = await db.select().from(bundles).where(and(
    eq(bundles.upload_session_id, bundleId), bundleAvailable(),
  )).get();
  if (!bundle) return { attached: false };
  const ids = parseItems(bundle.items).map((item) => item.item_id).filter(Boolean);
  if (!ids.length) return { attached: false };
  const receipts = await db.select().from(uploadItems).where(and(
    inArray(uploadItems.id, ids), eq(uploadItems.mirror_state, 'confirmed'),
    eq(uploadItems.state, 'accepted'), eq(uploadItems.kind, 'item'),
  )).all();
  let attached = false;
  for (const sessionId of new Set(receipts.map((receipt) => receipt.session_id))) {
    const operation = await db.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).get();
    if (!operation || (operation.mode === 'edit' ? operation.bundle_id : operation.id) !== bundleId) continue;
    const result = await projectMirrorReceipts(sessionId);
    attached ||= result.attached;
  }
  return { attached };
}

async function primaryContains(receipt) {
  const operation = await db.select().from(uploadSessions).where(eq(uploadSessions.id, receipt.session_id)).get();
  if (!operation || operation.state === 'deleted') return false;
  if (operation.mode !== 'edit' && operation.state !== 'complete') {
    return parseItems(operation.items).some((item) => item.item_id === receipt.id);
  }
  const bundleId = operation.mode === 'edit' ? operation.bundle_id : operation.id;
  const bundle = await db.select().from(bundles).where(and(
    eq(bundles.upload_session_id, bundleId), bundleAvailable(),
  )).get();
  return Boolean(bundle && parseItems(bundle.items).some((item) => item.item_id === receipt.id));
}

function conclusiveChannelFailure(error) {
  const status = Number(error?.code || error?.status || 0);
  const description = String(error?.description || error?.message || '');
  // A source-message restriction or a generic 403 does not prove that the
  // configured destination is unhealthy. Ambiguous failures keep it enabled.
  return (status === 400 || status === 403)
    && /CHAT_ADMIN_REQUIRED|not enough rights to (?:send|post)|bot.*kicked.*channel|not a member of (?:the )?channel/i.test(description);
}

export async function mirrorAcceptedItem(receipt, message, userId, chatId, lang) {
  let snapshot = null;
  let copied = false;
  try {
    receipt = await db.select().from(uploadItems).where(eq(uploadItems.id, receipt.id)).get();
    if (!receipt || receipt.kind !== 'item' || receipt.state !== 'accepted'
      || receipt.admin_id !== Number(userId) || receipt.item?.item_id !== receipt.id) return { mirrored: false };
    const operation = await db.select().from(uploadSessions).where(eq(uploadSessions.id, receipt.session_id)).get();
    if (receipt.mirror_state === 'confirmed' && validReceipt(receipt, operation)) {
      await projectMirrorReceipts(receipt.session_id);
      return { mirrored: true };
    }
    // Pending/unknown attempts have an uncertain remote outcome and must never
    // issue another copy merely because an update is replayed.
    if (receipt.mirror_state !== 'none') {
      const unresolved = receipt.mirror_state === 'pending' || receipt.mirror_state === 'unknown';
      if (unresolved) await warnMirror(userId, lang, false, new Error('MIRROR_OUTCOME_UNRESOLVED'));
      return { mirrored: false, unresolved };
    }
    if (!(await primaryContains(receipt))) return { mirrored: false };
    if (Number(message?.chat?.id || message?.chat_id) !== receipt.source_chat_id
      || Number(message?.message_id) !== receipt.source_message_id) throw new Error('MIRROR_SOURCE_MISMATCH');
    snapshot = await getStorageSnapshot();
    const enabled = snapshot.enabled && Boolean(snapshot.channel_id);
    const claimed = await db.update(uploadItems).set({
      mirror_state: enabled ? 'pending' : 'skipped', mirror_snapshot: snapshot.raw,
    }).where(and(eq(uploadItems.id, receipt.id), eq(uploadItems.state, 'accepted'),
      eq(uploadItems.mirror_state, 'none'))).run();
    if (claimed.rowsAffected !== 1 || !enabled) return { mirrored: false };
    let result;
    try {
      result = await copyMediaToStorage(message, receipt.item, receipt.item.type, snapshot.channel_id, tgApi);
      copied = true;
    } catch (error) {
      const status = Number(error?.code || error?.status || 0);
      try {
        await db.update(uploadItems).set({ mirror_state: status >= 400 && status < 500 ? 'failed' : 'unknown' })
          .where(and(eq(uploadItems.id, receipt.id), eq(uploadItems.mirror_state, 'pending'),
            eq(uploadItems.mirror_snapshot, snapshot.raw))).run();
      } catch (_) {}
      if (conclusiveChannelFailure(error)) {
        try { await disableStorageSnapshot(snapshot); } catch (_) {}
      }
      await warnMirror(userId, lang, false, error);
      return { mirrored: false };
    }
    if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) throw new Error('MIRROR_INVALID_RECEIPT');
    const saved = await db.update(uploadItems).set({ mirror_state: 'confirmed',
      storage_message_id: result.message_id, storage_channel_id: snapshot.channel_id,
    }).where(and(eq(uploadItems.id, receipt.id), eq(uploadItems.mirror_state, 'pending'),
      eq(uploadItems.mirror_snapshot, snapshot.raw))).run();
    if (saved.rowsAffected !== 1) throw new Error('MIRROR_RECEIPT_CONTENTION');
    await projectMirrorReceipts(receipt.session_id);
    return { mirrored: true };
  } catch (error) {
    await warnMirror(userId, lang, copied, error);
    return { mirrored: false, unresolved: copied };
  }
}

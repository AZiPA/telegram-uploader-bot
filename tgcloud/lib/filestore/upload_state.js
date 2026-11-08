import { db } from 'sdk';
import { eq, and, sql } from 'sdk/db';
import { bundles, uploadSessions, uploadItems } from '../../schema.js';
import { getConfig, nowSec, parseItems } from '../shared/config.js';
import { generateBundleCode } from '../shared/crypto.js';
import { getAdminSession, replaceAdminSession, updateAdminSession, sessionIdentityActive } from '../shared/sessions.js';
import { LIMITS } from '../shared/constants.js';
import { getManagedBundleFresh, bundleMutationGuard } from '../bundles/permissions.js';
import { bundleAvailable, cleanupDeletedBundle, ensureBundleIdentity } from '../bundles/lifecycle.js';
import { projectMirrorReceipts, recoverBundleMirrorReceipts } from './upload_mirror.js';

export const UPLOAD_CAS_ATTEMPTS = 4;

// Claim a start update before installing its pointer. A retry can finish this
// exact installation, but cannot replace a newer wizard or upload operation.
export async function startUploadOperation(userId, mode, ctx) {
  const updateId = ctx?.update?.update_id;
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    const session = await replaceAdminSession(userId, { code: '', mode, items: '[]' });
    return { session, op: await getUploadOperation(session) };
  }
  const identity = and(eq(uploadSessions.admin_id, Number(userId)), eq(uploadSessions.start_update_id, updateId));
  let op = await db.select().from(uploadSessions).where(identity).get();
  if (!op) {
    const previous = await getAdminSession(userId);
    await db.insert(uploadSessions).values({
      id: crypto.randomUUID(), admin_id: Number(userId), generation: crypto.randomUUID(),
      mode, bundle_code: '', state: 'starting', start_update_id: updateId,
      start_pointer: previous || null, created_at: nowSec(), updated_at: nowSec(),
    }).onConflictDoNothing({ target: [uploadSessions.admin_id, uploadSessions.start_update_id] }).run();
    op = await db.select().from(uploadSessions).where(identity).get();
  }
  if (!op || op.mode !== mode) throw new Error('UPLOAD_IDENTITY_CONFLICT');
  for (let attempt = 0; attempt < UPLOAD_CAS_ATTEMPTS; attempt++) {
    let pointer = await getAdminSession(userId);
    const matches = (row) => row?.session_id === op.id && row?.generation === op.generation;
    if (op.state !== 'starting') return { session: matches(pointer) ? pointer : null, op };
    if (!matches(pointer)) {
      pointer = await replaceAdminSession(userId, {
        code: '', mode, items: '[]', session_id: op.id, generation: op.generation,
      }, db, op.start_pointer);
    }
    const currentPointer = pointer || await getAdminSession(userId);
    const nextState = matches(currentPointer) ? 'open' : 'cancelled';
    const changed = await db.update(uploadSessions).set({ state: nextState, revision: op.revision + 1 })
      .where(and(eq(uploadSessions.id, op.id), eq(uploadSessions.state, 'starting'), eq(uploadSessions.revision, op.revision))).run();
    if (changed.rowsAffected === 1) return { session: nextState === 'open' ? currentPointer : null,
      op: { ...op, state: nextState, revision: op.revision + 1 } };
    op = await db.select().from(uploadSessions).where(identity).get();
    if (!op) throw new Error('UPLOAD_SESSION_CHANGED');
  }
  throw new Error('UPLOAD_CONTENTION');
}

export function sortUploadItems(items) {
  const chats = new Map();
  const key = (item) => String(item.source_chat_id ?? 'legacy');
  for (const item of items) if (!chats.has(key(item))) chats.set(key(item), chats.size);
  // Chat-local message numbers are comparable only within their source chat.
  // First-seen chat order gives a transitive, stable ordering across chats.
  return [...items].sort((a, b) => chats.get(key(a)) - chats.get(key(b))
    || Number(a.source_message_id || 0) - Number(b.source_message_id || 0));
}

export async function captureUploadSession(userId) {
  let session = await getAdminSession(userId);
  if (!session || !['upload', 'batch', 'edit'].includes(session.mode)) return null;
  if (!session.session_id || !session.generation) {
    if (nowSec() - session.updated_at > 600) return session;
    session = await updateAdminSession(session, {
      session_id: crypto.randomUUID(), generation: crypto.randomUUID(),
    });
  }
  return session;
}

// Bind an editor before publishing its prompt pointer. Even a crash between
// these writes leaves the exact target durable, never an ambiguous public code.
export async function startEditSession(userId, observedBundle, expected = undefined) {
  const bundle = await ensureBundleIdentity(observedBundle);
  if (!bundle) return null;
  const id = crypto.randomUUID(), generation = crypto.randomUUID();
  await db.insert(uploadSessions).values({ id, generation, admin_id: Number(userId),
    mode: 'edit', bundle_code: bundle.code, bundle_id: bundle.upload_session_id,
    state: 'open', created_at: nowSec(), updated_at: nowSec(),
  }).run();
  const pointer = await replaceAdminSession(userId, { code: bundle.code, mode: 'edit',
    items: bundle.items, session_id: id, generation }, db, expected);
  if (!pointer) await db.update(uploadSessions).set({ state: 'cancelled', revision: 1 })
    .where(and(eq(uploadSessions.id, id), eq(uploadSessions.state, 'open'), eq(uploadSessions.revision, 0))).run();
  return pointer;
}

export async function getUploadOperation(session) {
  if (!session?.session_id) throw new Error('UPLOAD_SESSION_CHANGED');
  const existing = await db.select().from(uploadSessions).where(eq(uploadSessions.id, session.session_id)).get();
  if (existing) {
    if (existing.generation !== session.generation || existing.admin_id !== session.admin_id
      || existing.mode !== session.mode || existing.bundle_code !== session.code) throw new Error('UPLOAD_SESSION_CHANGED');
    if (existing.mode === 'edit') {
      // A rotation may have committed before its prompt rebind. Never resolve
      // that old edit operation through a reused public code.
      const target = await db.select().from(bundles).where(and(
        eq(bundles.upload_session_id, existing.bundle_id), eq(bundles.code, session.code),
        bundleMutationGuard(session.admin_id),
      )).get();
      if (!target) throw new Error('UPLOAD_ACCESS_DENIED');
    }
    return existing;
  }
  let bundleId = '';
  if (session.mode === 'edit') {
    const managed = await getManagedBundleFresh(session.code, session.admin_id);
    if (!managed.allowed) throw new Error('UPLOAD_ACCESS_DENIED');
    const bundle = await ensureBundleIdentity(managed.row);
    if (!bundle?.upload_session_id) throw new Error('UPLOAD_ACCESS_DENIED');
    bundleId = bundle.upload_session_id;
  }
  await db.insert(uploadSessions).values({
    id: session.session_id, admin_id: session.admin_id, generation: session.generation,
    mode: session.mode, bundle_code: session.code, bundle_id: bundleId,
    items: parseItems(session.items), created_at: nowSec(), updated_at: nowSec(),
  }).onConflictDoNothing({ target: uploadSessions.id }).run();
  const op = await db.select().from(uploadSessions).where(eq(uploadSessions.id, session.session_id)).get();
  if (!op || op.generation !== session.generation || op.mode !== session.mode || op.bundle_code !== session.code) {
    throw new Error('UPLOAD_SESSION_CHANGED');
  }
  return op;
}

export async function uploadSessionExpired(session) {
  const op = session.session_id
    ? await db.select().from(uploadSessions).where(eq(uploadSessions.id, session.session_id)).get() : null;
  if (op?.state === 'finalizing') return false;
  return nowSec() - Math.max(Number(session.updated_at || 0), Number(op?.updated_at || 0)) > 600;
}

async function touchEditActivity(operationId) {
  for (let attempt = 0; attempt < UPLOAD_CAS_ATTEMPTS; attempt++) {
    const op = await db.select().from(uploadSessions).where(eq(uploadSessions.id, operationId)).get();
    if (!op) throw new Error('UPLOAD_SESSION_CHANGED');
    const changed = await db.update(uploadSessions).set({ updated_at: nowSec(), revision: op.revision + 1 })
      .where(and(eq(uploadSessions.id, op.id), eq(uploadSessions.revision, op.revision),
        eq(uploadSessions.generation, op.generation), eq(uploadSessions.mode, 'edit'), eq(uploadSessions.state, 'open'))).run();
    if (changed.rowsAffected === 1) return;
  }
  throw new Error('UPLOAD_CONTENTION');
}

export async function findUpdateReceipt(userId, ctx) {
  const updateId = ctx?.update?.update_id;
  if (!Number.isSafeInteger(updateId) || updateId < 0) return null;
  return db.select().from(uploadItems).where(and(
    eq(uploadItems.admin_id, Number(userId)), eq(uploadItems.update_id, updateId),
  )).get();
}

export async function hasAcceptedUploadReceipt(receipt) {
  if (receipt.kind !== 'item') return false;
  if (receipt.state === 'accepted' || receipt.state === 'duplicate') return true;
  const op = await db.select().from(uploadSessions).where(eq(uploadSessions.id, receipt.session_id)).get();
  if (!op) return false;
  if (op.mode !== 'edit') return parseItems(op.items).some((item) => item.item_id === receipt.id);
  const bundle = op.bundle_id
    ? await db.select().from(bundles).where(eq(bundles.upload_session_id, op.bundle_id)).get()
    : await db.select().from(bundles).where(eq(bundles.code, op.bundle_code)).get();
  return Boolean(bundle && (parseItems(bundle.items).some((item) => item.item_id === receipt.id)
    || parseItems(bundle.removed_item_ids).includes(receipt.id)));
}

export async function claimUploadItem(session, message, payload, ctx, kind = 'item') {
  const sourceChat = Number(message?.chat?.id);
  const sourceMessage = Number(message?.message_id || 0);
  if (!Number.isSafeInteger(sourceChat) || !Number.isSafeInteger(sourceMessage) || sourceMessage < 0 || (kind === 'item' && sourceMessage === 0)) {
    throw new Error('UPLOAD_INVALID_SOURCE');
  }
  const updateId = ctx?.update?.update_id;
  const id = crypto.randomUUID();
  const item = kind !== 'item' ? { kind, ...(kind === 'cancel' ? { target: session } : {}) } : {
    item_id: id, file_id: payload.file_id, file_unique_id: payload.file_unique_id || '',
    type: payload.mediaType, file_name: payload.file_name || undefined,
    caption: payload.caption || undefined, file_size: payload.file_size || 0,
    source_chat_id: sourceChat, source_message_id: sourceMessage,
  };
  await db.insert(uploadItems).values({
    id, session_id: session.session_id, admin_id: session.admin_id,
    source_chat_id: sourceChat, source_message_id: sourceMessage,
    update_id: Number.isSafeInteger(updateId) && updateId >= 0 ? updateId : null,
    kind, item,
  }).onConflictDoNothing().run();
  const receipt = await findUpdateReceipt(session.admin_id, ctx) || await db.select().from(uploadItems)
    .where(and(eq(uploadItems.session_id, session.session_id),
      eq(uploadItems.source_chat_id, sourceChat), eq(uploadItems.source_message_id, sourceMessage))).get();
  if (!receipt || receipt.kind !== kind) throw new Error('UPLOAD_IDENTITY_CONFLICT');
  return receipt;
}

export async function markUploadReceipt(receipt, state) {
  if (receipt.state === state) return;
  const changed = await db.update(uploadItems).set({ state })
    .where(and(eq(uploadItems.id, receipt.id), eq(uploadItems.state, receipt.state))).run();
  if (changed.rowsAffected !== 1) {
    const current = await db.select().from(uploadItems).where(eq(uploadItems.id, receipt.id)).get();
    if (current?.state !== state) throw new Error('UPLOAD_RECEIPT_CONTENTION');
  }
}

async function sealOptions() {
  const ttlHours = Number(await getConfig('bundle_ttl_hours', '0')) || 0;
  const protect = (await getConfig('default_protect_content', '0')) === '1';
  return { result_code: generateBundleCode(protect), protect_content: protect,
    expires_at: ttlHours > 0 ? nowSec() + ttlHours * 3600 : 0 };
}

export async function acceptUploadItem(session, receipt) {
  if (receipt.session_id !== session.session_id || receipt.kind !== 'item') throw new Error('UPLOAD_SESSION_CHANGED');
  for (let attempt = 0; attempt < UPLOAD_CAS_ATTEMPTS; attempt++) {
    const op = await getUploadOperation(session);
    if (session.mode === 'edit') return acceptEditItem(session, receipt, op);
    const items = parseItems(op.items);
    if (items.some((item) => item.item_id === receipt.id)) {
      await markUploadReceipt(receipt, 'accepted');
      return { op, receipt, accepted: true };
    }
    if (op.state !== 'open' || session.state !== 'active') {
      await markUploadReceipt(receipt, 'rejected');
      return { op, receipt, accepted: false };
    }
    const duplicate = items.find((item) => receipt.item.file_unique_id && item.file_unique_id === receipt.item.file_unique_id);
    if (duplicate) {
      await markUploadReceipt(receipt, 'duplicate');
      return { op, receipt, accepted: true, duplicate: true };
    }
    if (items.length >= LIMITS.MAX_BUNDLE_ITEMS || items.length >= LIMITS.MAX_PER_SESSION_UPLOAD) {
      await markUploadReceipt(receipt, 'rejected');
      return { op, receipt, accepted: false, limit: true };
    }
    const next = sortUploadItems([...items, receipt.item]);
    const sealing = session.mode === 'upload';
    const options = sealing ? await sealOptions() : {};
    const changed = await db.update(uploadSessions).set({
      items: next, revision: op.revision + 1, updated_at: nowSec(),
      ...(sealing ? { ...options, state: 'finalizing' } : {}),
    }).where(and(eq(uploadSessions.id, op.id), eq(uploadSessions.revision, op.revision),
      eq(uploadSessions.state, 'open'), sessionIdentityActive(session))).run();
    if (changed.rowsAffected === 1) {
      await markUploadReceipt(receipt, 'accepted');
      return { op: { ...op, ...options, items: next, revision: op.revision + 1,
        state: sealing ? 'finalizing' : 'open' }, receipt, accepted: true };
    }
    const pointer = await getAdminSession(session.admin_id);
    if (!pointer || pointer.session_id !== session.session_id || pointer.generation !== session.generation
      || pointer.mode !== session.mode || pointer.code !== session.code || pointer.state !== 'active') {
      await markUploadReceipt(receipt, 'rejected');
      return { op, receipt, accepted: false };
    }
  }
  throw new Error('UPLOAD_CONTENTION');
}

async function acceptEditItem(session, receipt, op) {
  try { await recoverBundleMirrorReceipts(op.bundle_id); } catch (error) {
    console.warn('Confirmed mirror projection deferred:', error?.message || error);
  }
  for (let attempt = 0; attempt < UPLOAD_CAS_ATTEMPTS; attempt++) {
    const managed = await getManagedBundleFresh(session.code, session.admin_id);
    if (!managed.allowed) return { op, receipt, accepted: false };
    const bundle = managed.row;
    if (bundle.upload_session_id !== op.bundle_id) throw new Error('UPLOAD_SESSION_CHANGED');
    receipt = await db.select().from(uploadItems).where(eq(uploadItems.id, receipt.id)).get();
    if (receipt.state === 'accepted' || receipt.state === 'duplicate') return { op, receipt, accepted: true, duplicate: true };
    if (receipt.state === 'rejected') return { op, receipt, accepted: false };
    const items = parseItems(bundle.items);
    const retired = parseItems(bundle.removed_item_ids);
    if (items.some((item) => item.item_id === receipt.id) || retired.includes(receipt.id)) {
      await markUploadReceipt(receipt, 'accepted');
      return { op, receipt, accepted: true };
    }
    if (receipt.state === 'pending') {
      const claimed = await db.update(uploadItems).set({ state: 'committing' })
        .where(and(eq(uploadItems.id, receipt.id), eq(uploadItems.state, 'pending'), sessionIdentityActive(session))).run();
      if (claimed.rowsAffected !== 1) continue;
      receipt = { ...receipt, state: 'committing' };
    }
    if (items.some((item) => receipt.item.file_unique_id && item.file_unique_id === receipt.item.file_unique_id)) {
      await markUploadReceipt(receipt, 'duplicate');
      return { op, receipt, accepted: true, duplicate: true };
    }
    if (items.length >= LIMITS.MAX_BUNDLE_ITEMS) {
      await markUploadReceipt(receipt, 'rejected');
      return { op, receipt, accepted: false, limit: true };
    }
    const changed = await db.update(bundles).set({ items: sortUploadItems([...items, receipt.item]) })
      .where(and(eq(bundles.code, session.code), eq(bundles.upload_session_id, op.bundle_id), eq(bundles.items, bundle.items),
        eq(bundles.removed_item_ids, bundle.removed_item_ids),
        bundleMutationGuard(session.admin_id), sessionIdentityActive(session))).run();
    if (changed.rowsAffected === 1) {
      await markUploadReceipt(receipt, 'accepted');
      await touchEditActivity(op.id);
      return { op, receipt, accepted: true };
    }
  }
  throw new Error('UPLOAD_CONTENTION');
}

export async function sealUploadSession(session) {
  for (let attempt = 0; attempt < UPLOAD_CAS_ATTEMPTS; attempt++) {
    const op = await getUploadOperation(session);
    if (['finalizing', 'complete', 'deleted'].includes(op.state)) return op;
    if (op.state !== 'open' || !parseItems(op.items).length) return null;
    const options = await sealOptions();
    const changed = await db.update(uploadSessions).set({
      ...options, state: 'finalizing', revision: op.revision + 1,
    }).where(and(eq(uploadSessions.id, op.id), eq(uploadSessions.revision, op.revision),
      eq(uploadSessions.state, 'open'), sessionIdentityActive(session))).run();
    if (changed.rowsAffected === 1) return { ...op, ...options, state: 'finalizing', revision: op.revision + 1 };
  }
  throw new Error('UPLOAD_CONTENTION');
}

export async function completeUploadSession(operationId, observedSession = null) {
  for (let attempt = 0; attempt < UPLOAD_CAS_ATTEMPTS; attempt++) {
    const op = await db.select().from(uploadSessions).where(eq(uploadSessions.id, operationId)).get();
    if (op?.state === 'deleted') {
      await cleanupDeletedBundle(op.id);
      if (observedSession) await updateAdminSession(observedSession, { state: 'deleted' });
      return null;
    }
    if (!op || !['finalizing', 'complete'].includes(op.state)) throw new Error('UPLOAD_NOT_FINALIZING');
    let bundle = await db.select().from(bundles).where(and(eq(bundles.upload_session_id, op.id), bundleAvailable())).get();
    if (!bundle && op.state === 'complete') throw new Error('UPLOAD_BUNDLE_MISSING');
    if (!bundle) {
      try {
        // One atomic statement arbitrates with the tombstone transition.
        // Raw DB calls return raw values; copy persisted JSON/booleans in SQL.
        await db.run(sql`INSERT INTO bundles
          (code, title, items, protect_content, expires_at, created_by, created_at, upload_session_id)
          SELECT result_code, NULL, items, protect_content, expires_at, admin_id, ${nowSec()}, id
          FROM upload_sessions WHERE id = ${op.id} AND state = 'finalizing'
            AND revision = ${op.revision} AND result_code = ${op.result_code}
          ON CONFLICT DO NOTHING`);
      } catch (error) {
        // A response can be lost after commit. Find the durable association before failing.
        bundle = await db.select().from(bundles).where(and(eq(bundles.upload_session_id, op.id), bundleAvailable())).get();
        const latest = await db.select().from(uploadSessions).where(eq(uploadSessions.id, op.id)).get();
        if (latest?.state === 'deleted') continue;
        if (!bundle) throw error;
      }
      bundle ||= await db.select().from(bundles).where(and(eq(bundles.upload_session_id, op.id), bundleAvailable())).get();
      if (!bundle) {
        const latest = await db.select().from(uploadSessions).where(eq(uploadSessions.id, op.id)).get();
        if (latest?.state !== 'finalizing' || latest.revision !== op.revision) continue;
        const reallocated = await db.update(uploadSessions).set({ result_code: generateBundleCode(op.protect_content), revision: op.revision + 1 })
          .where(and(eq(uploadSessions.id, op.id), eq(uploadSessions.revision, op.revision), eq(uploadSessions.state, 'finalizing'))).run();
        if (reallocated.rowsAffected !== 1) continue;
        continue;
      }
    }
    if (op.state !== 'complete') {
      const completed = await db.update(uploadSessions).set({ state: 'complete', result_code: bundle.code, revision: op.revision + 1 })
        .where(and(eq(uploadSessions.id, op.id), eq(uploadSessions.revision, op.revision), eq(uploadSessions.state, 'finalizing'),
          sql`EXISTS (SELECT 1 FROM bundles WHERE upload_session_id = ${op.id})`)).run();
      if (completed.rowsAffected !== 1) continue;
    }
    if (observedSession) observedSession = await updateAdminSession(observedSession, { state: 'complete' }) || observedSession;
    try { await projectMirrorReceipts(op.id); } catch (error) {
      console.warn('Confirmed mirror projection deferred:', error?.message || error);
    }
    // A deletion may have won after bookkeeping or during receipt projection.
    const latest = await db.select().from(uploadSessions).where(eq(uploadSessions.id, op.id)).get();
    if (latest?.state === 'deleted') continue;
    return db.select().from(bundles).where(and(eq(bundles.upload_session_id, op.id), bundleAvailable())).get();
  }
  throw new Error('UPLOAD_CONTENTION');
}


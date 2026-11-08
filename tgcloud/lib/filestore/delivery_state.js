import { db } from 'sdk';
import { and, eq, sql } from 'sdk/db';
import { bundles, deliveryOperations, deliveryAttempts, deliveryItems, deletionQueue } from '../../schema.js';
import { nowSec, parseItems } from '../shared/config.js';
import { generateBase62Code } from '../shared/crypto.js';
import { bundleAvailable, ensureBundleIdentity } from '../bundles/lifecycle.js';
import { bundleMutationGuard } from '../bundles/permissions.js';

const TOKEN = /^[A-Za-z0-9]{22}$/;
const LEASE_SECONDS = 120;
export const DELIVERY_TTL = 86400;

export function stableDeliveryItemId(item) {
  return String(item.item_id || item.file_unique_id ||
    (item.source_chat_id && item.source_message_id ? `source:${item.source_chat_id}:${item.source_message_id}` : `file:${item.file_id}`));
}

export function deliveryCallback(id, offset) {
  if (!TOKEN.test(id) || !Number.isInteger(offset) || offset < 0 || offset >= 25) throw new Error('Invalid delivery continuation');
  return `dl:p:o:${id}:${offset}`;
}

export function parseDeliveryCallback(data) {
  const match = /^dl:p:o:([A-Za-z0-9]{22}):(0|[1-9][0-9]?)$/.exec(data);
  return match && Number(match[2]) < 25 ? { id: match[1], offset: Number(match[2]) } : null;
}

export function deliveryRequestKey(ctx, userId, chatId, adminTestId = '') {
  const update = ctx?.update;
  const callback = update?.callback_query;
  // Distinct taps on the same displayed button are one logical request.
  if (callback?.message?.message_id && callback.data) {
    return `button:${userId}:${chatId}:${callback.message.message_id}:${callback.data}`;
  }
  if (Number.isSafeInteger(update?.update_id)) return `update:${userId}:${chatId}:${update.update_id}`;
  // Direct internal calls have no Telegram replay identity.
  return `internal:${adminTestId}:${generateBase62Code(22)}`;
}

export async function getDeliveryOperation(id, userId, chatId) {
  if (!TOKEN.test(String(id))) return null;
  const op = await db.select().from(deliveryOperations).where(and(eq(deliveryOperations.id, id),
    eq(deliveryOperations.user_id, Number(userId)), eq(deliveryOperations.chat_id, Number(chatId)))).get();
  return op && op.expires_at > nowSec() ? op : null;
}

export async function findDeliveryRequest(requestKey, userId, chatId) {
  const op = await db.select().from(deliveryOperations).where(eq(deliveryOperations.request_key, requestKey)).get();
  return op && op.user_id === Number(userId) && op.chat_id === Number(chatId) ? op : null;
}

export async function findAdminDelivery(adminTestId, userId, chatId) {
  const operations = await db.select().from(deliveryOperations).where(and(
    eq(deliveryOperations.admin_test_id, adminTestId), eq(deliveryOperations.user_id, Number(userId)),
    eq(deliveryOperations.chat_id, Number(chatId)), sql`expires_at > ${nowSec()}`,
  )).limit(2).all();
  return operations.length === 1 ? operations[0] : null;
}

export async function createDeliveryOperation(bundle, userId, chatId, requestKey, adminTestId = '') {
  const previous = await findDeliveryRequest(requestKey, userId, chatId);
  if (previous) return previous;
  bundle = await ensureBundleIdentity(bundle);
  if (!bundle) return null;
  const now = nowSec();
  const op = {
    id: generateBase62Code(22), request_key: requestKey, user_id: Number(userId), chat_id: Number(chatId),
    bundle_id: bundle.upload_session_id, bundle_code: bundle.code,
    items: parseItems(bundle.items).map((item) => ({ ...item, item_id: stableDeliveryItemId(item) })),
    attempt_id: generateBase62Code(22), admin_test_id: adminTestId, expires_at: now + DELIVERY_TTL,
    created_at: now, updated_at: now,
    state: sql`CASE WHEN EXISTS (SELECT 1 FROM bundles WHERE upload_session_id = ${bundle.upload_session_id}
      AND (expires_at = 0 OR expires_at > ${now}) AND ${bundleAvailable()})
      AND NOT EXISTS (SELECT 1 FROM system_config WHERE key = 'reset_in_progress' AND value = '1')
      THEN 'active' ELSE 'aborted' END`,
  };
  await db.insert(deliveryOperations).values(op).onConflictDoNothing({ target: deliveryOperations.request_key }).run();
  return await findDeliveryRequest(requestKey, userId, chatId);
}

export async function initializeDeliveryAttempt(op) {
  await db.insert(deliveryAttempts).values({
    id: op.attempt_id, operation_id: op.id, user_id: op.user_id, chat_id: op.chat_id,
    bundle_id: op.bundle_id, quota_code: op.bundle_code, period: new Date(op.created_at * 1000).toISOString().slice(0, 10),
    created_at: op.created_at, updated_at: nowSec(),
    state: sql`CASE WHEN EXISTS (SELECT 1 FROM delivery_operations WHERE id = ${op.id} AND state = 'active')
      AND NOT EXISTS (SELECT 1 FROM system_config WHERE key = 'reset_in_progress' AND value = '1')
      THEN 'active' ELSE 'aborted' END`,
  }).onConflictDoNothing({ target: deliveryAttempts.id }).run();
  // Recover interruption between operation/attempt/items creation idempotently.
  for (const item of parseItems(op.items)) {
    await db.insert(deliveryItems).values({ id: `${op.attempt_id}:${item.item_id}`,
      attempt_id: op.attempt_id, item_id: item.item_id, updated_at: nowSec(),
    }).onConflictDoNothing({ target: deliveryItems.id }).run();
  }
  return await readDeliveryAttempt(op.attempt_id);
}

export async function readDeliveryAttempt(id) {
  return await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.id, id)).get();
}

export async function deliveryReceipts(attemptId) {
  return await db.select().from(deliveryItems).where(eq(deliveryItems.attempt_id, attemptId)).all();
}

export async function acquireDeliveryAttempt(op) {
  const owner = generateBase62Code(22), now = nowSec();
  const changed = await db.update(deliveryAttempts).set({ lease_owner: owner, lease_until: now + LEASE_SECONDS, updated_at: now })
    .where(and(eq(deliveryAttempts.id, op.attempt_id), sql`state IN ('active', 'paused')`,
      sql`lease_until <= ${now}`, sql`retry_at <= ${now}`,
      sql`EXISTS (SELECT 1 FROM delivery_operations WHERE id = ${op.id} AND state = 'active')`,
      sql`NOT EXISTS (SELECT 1 FROM system_config WHERE key = 'reset_in_progress' AND value = '1')`)).run();
  if (changed.rowsAffected !== 1) return null;
  // A lost invocation at any point after the boundary has an unknown outcome,
  // including a crash before the network call itself. A lease is never proof.
  if ((await deliveryReceipts(op.attempt_id)).some((receipt) => receipt.state === 'dispatching')) {
    try {
      await db.update(deliveryItems).set({ state: 'unknown', updated_at: now }).where(and(
        eq(deliveryItems.attempt_id, op.attempt_id), eq(deliveryItems.state, 'dispatching'))).run();
    } catch (error) {
      await releaseDeliveryAttempt(op, owner);
      throw error;
    }
  }
  return owner;
}

export async function releaseDeliveryAttempt(op, owner) {
  await db.update(deliveryAttempts).set({ lease_owner: '', lease_until: 0, updated_at: nowSec() })
    .where(and(eq(deliveryAttempts.id, op.attempt_id), eq(deliveryAttempts.lease_owner, owner))).run();
}

export async function currentDeliveryBundle(op) {
  return await db.select().from(bundles).where(and(eq(bundles.upload_session_id, op.bundle_id), bundleAvailable(),
    sql`(expires_at = 0 OR expires_at > ${nowSec()})`)).get();
}

export function currentDeliveryItem(bundle, snapshot) {
  const removed = parseItems(bundle.removed_item_ids);
  if (removed.includes(snapshot.item_id)) return null;
  return parseItems(bundle.items).find((item) => stableDeliveryItemId(item) === snapshot.item_id) || null;
}

export async function skipDeliveryItem(op, item) {
  await db.update(deliveryItems).set({ state: 'skipped', updated_at: nowSec() }).where(and(
    eq(deliveryItems.id, `${op.attempt_id}:${item.item_id}`), sql`state IN ('pending', 'failed')`)).run();
}

export async function startDeliveryDispatch(op, owner, item, stage = 'primary', method = '', expectedProtection) {
  const bundle = await currentDeliveryBundle(op);
  if (!bundle || !currentDeliveryItem(bundle, item)) throw new Error('Delivery content is no longer available');
  const protection = expectedProtection === undefined ? Boolean(bundle.protect_content) : Boolean(expectedProtection);
  const now = nowSec();
  const changed = await db.update(deliveryItems).set({ state: 'dispatching', stage, method, updated_at: now })
    .where(and(eq(deliveryItems.id, `${op.attempt_id}:${item.item_id}`), sql`state IN ('pending', 'failed')`,
      sql`retry_at <= ${now}`,
      sql`NOT EXISTS (SELECT 1 FROM system_config WHERE key = 'reset_in_progress' AND value = '1')`,
      sql`EXISTS (SELECT 1 FROM delivery_operations WHERE id = ${op.id} AND state = 'active')`,
      sql`NOT EXISTS (SELECT 1 FROM user_quotas WHERE user_id = ${op.user_id}
        AND (banned_until = -1 OR banned_until > ${now}))`,
      sql`EXISTS (SELECT 1 FROM delivery_attempts WHERE id = ${op.attempt_id}
        AND lease_owner = ${owner} AND lease_until > ${now} AND state IN ('active', 'paused')
        AND quota_state IN ('reserved', 'consumed', 'exempt'))`,
      sql`EXISTS (SELECT 1 FROM bundles WHERE upload_session_id = ${op.bundle_id}
        AND items = ${JSON.stringify(parseItems(bundle.items))} AND removed_item_ids = ${JSON.stringify(parseItems(bundle.removed_item_ids))}
        AND protect_content = ${protection}
        AND (expires_at = 0 OR expires_at > ${now}) AND ${bundleAvailable()}
        AND ${op.admin_test_id ? bundleMutationGuard(op.user_id) : sql`1`}
        AND (is_one_time = 0 OR ${Boolean(op.admin_test_id)} OR
          ((consumed_by = 0 OR consumed_by = ${op.user_id}) AND EXISTS
            (SELECT 1 FROM delivery_claims WHERE bundle_id = ${op.bundle_id}
              AND attempt_id = ${op.attempt_id} AND state IN ('reserved', 'consumed')))))`,
    )).run();
  if (changed.rowsAffected !== 1) throw new Error('Delivery dispatch claim lost');
}

export async function confirmDeliveryItem(op, item, messageId, autoDeleteSeconds = 0) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Invalid delivery receipt');
  const set = { state: 'confirmed', message_id: messageId, updated_at: nowSec(),
    delete_at: autoDeleteSeconds > 0 ? nowSec() + autoDeleteSeconds : 0,
    queue_state: autoDeleteSeconds > 0 ? 'pending' : 'none' };
  // Retry durable bookkeeping from the known result, never repeat Telegram.
  let lastError;
  for (let retry = 0; retry < 3; retry++) {
    try {
      await db.update(deliveryItems).set(set).where(and(eq(deliveryItems.id, `${op.attempt_id}:${item.item_id}`),
        sql`state IN ('dispatching', 'unknown')`)).run();
      const receipt = await db.select().from(deliveryItems).where(eq(deliveryItems.id, `${op.attempt_id}:${item.item_id}`)).get();
      if (receipt?.state === 'confirmed' && receipt.message_id === messageId) return receipt;
      throw new Error('Delivery receipt conflict');
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function recordDeliveryOutcome(op, item, outcome) {
  const unknown = outcome.kind === 'unknown';
  const retryAt = outcome.kind === 'rate_limited' ? nowSec() + (outcome.retryAfter || 60) : 0;
  await db.update(deliveryItems).set({ state: unknown ? 'unknown' : 'failed', retry_at: retryAt, updated_at: nowSec() })
    .where(and(eq(deliveryItems.id, `${op.attempt_id}:${item.item_id}`), sql`state IN ('dispatching', 'pending', 'failed')`)).run();
  if (retryAt) await db.update(deliveryAttempts).set({ retry_at: retryAt, state: 'paused', updated_at: nowSec() })
    .where(eq(deliveryAttempts.id, op.attempt_id)).run();
}

export async function projectDeliveryDeletionQueue(op) {
  for (const receipt of await deliveryReceipts(op.attempt_id)) {
    if (receipt.state !== 'confirmed' || receipt.queue_state !== 'pending' || receipt.delete_at <= 0) continue;
    // A per-receipt identity makes queue insertion recoverable after lost replies.
    await db.insert(deletionQueue).values({ chat_id: op.chat_id, message_ids: JSON.stringify([receipt.message_id]),
      delete_at: receipt.delete_at, delivery_receipt_id: receipt.id,
    }).onConflictDoNothing({ target: deletionQueue.delivery_receipt_id }).run();
    await db.update(deliveryItems).set({ queue_state: 'queued' }).where(and(eq(deliveryItems.id, receipt.id), eq(deliveryItems.state, 'confirmed'))).run();
  }
}

export async function setDeliveryTerminal(op, state, owner) {
  const changed = await db.update(deliveryAttempts).set({ state, updated_at: nowSec() }).where(and(
    eq(deliveryAttempts.id, op.attempt_id), eq(deliveryAttempts.lease_owner, owner), sql`state IN ('active', 'paused')`)).run();
  if (changed.rowsAffected === 1) await db.update(deliveryOperations).set({ state, updated_at: nowSec() })
    .where(and(eq(deliveryOperations.id, op.id), eq(deliveryOperations.state, 'active'))).run();
}

export async function recoverDeliveryTerminal(op, attempt) {
  if (!['complete', 'failed', 'unknown', 'aborted'].includes(attempt.state)) return false;
  await db.update(deliveryOperations).set({ state: attempt.state, updated_at: nowSec() }).where(and(
    eq(deliveryOperations.id, op.id), eq(deliveryOperations.state, 'active'),
    sql`EXISTS (SELECT 1 FROM delivery_attempts WHERE id = ${attempt.id} AND state = ${attempt.state})`,
  )).run();
  return true;
}

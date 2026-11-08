import { db } from 'sdk';
import { and, eq, sql } from 'sdk/db';
import { routerUpdates, deliveryItems, deliveryAttempts, deliveryOperations, uploadItems } from '../../schema.js';
import { nowSec } from '../shared/config.js';

const UPDATE_LEASE_SECONDS = 180;
const seenUpdates = new Set();

function updateId(ctx) {
  const id = ctx?.update?.update_id;
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function ownedUpdate(ctx) {
  return and(eq(routerUpdates.update_id, updateId(ctx)), eq(routerUpdates.token, ctx.router_update_token),
    eq(routerUpdates.state, 'in_progress'));
}

export async function beginUpdate(ctx) {
  const id = updateId(ctx);
  if (id === null) return true;
  // This Set is an optimization for terminal keys only. Durable SQLite is the
  // arbiter across isolates and for retries after a pre-dispatch failure.
  if (seenUpdates.has(id)) return false;
  const now = nowSec(), token = crypto.randomUUID();
  const inserted = await db.insert(routerUpdates).values({ update_id: id, token,
    lease_until: now + UPDATE_LEASE_SECONDS, created_at: now, updated_at: now,
  }).onConflictDoNothing({ target: routerUpdates.update_id }).run();
  if (inserted.rowsAffected === 1) { ctx.router_update_token = token; return true; }
  const existing = await db.select().from(routerUpdates).where(eq(routerUpdates.update_id, id)).get();
  if (!existing || ['completed', 'unknown'].includes(existing.state)) return false;
  // A lease expiry proves neither failure nor non-delivery. The durable marker
  // is written before every guarded/domain dispatch, even before the API call.
  if (existing.state === 'in_progress' && existing.lease_until <= now && existing.dispatched) {
    await db.update(routerUpdates).set({ state: 'unknown', lease_until: 0, updated_at: now })
      .where(and(eq(routerUpdates.update_id, id), eq(routerUpdates.token, existing.token),
        eq(routerUpdates.state, 'in_progress'), sql`lease_until <= ${now}`, eq(routerUpdates.dispatched, 1))).run();
    return false;
  }
  const claimed = await db.update(routerUpdates).set({ state: 'in_progress', token,
    lease_until: now + UPDATE_LEASE_SECONDS, updated_at: now,
  }).where(and(eq(routerUpdates.update_id, id), eq(routerUpdates.token, existing.token),
    eq(routerUpdates.dispatched, 0), sql`(state = 'retryable' OR (state = 'in_progress' AND lease_until <= ${now}))`)).run();
  if (claimed.rowsAffected !== 1) return false;
  ctx.router_update_token = token;
  return true;
}

export async function linkUpdateOperation(ctx, kind, id) {
  if (!ctx?.router_update_token || updateId(ctx) === null || !id) return;
  if (!['delivery', 'upload'].includes(kind)) throw new Error('Invalid update operation kind');
  const changed = await db.update(routerUpdates).set({ operation_kind: kind, operation_id: id, updated_at: nowSec() })
    .where(ownedUpdate(ctx)).run();
  if (changed.rowsAffected !== 1) throw new Error('UPDATE_LEASE_LOST');
}

export async function markUpdateDispatch(ctx, content = false) {
  if (!ctx?.router_update_token || updateId(ctx) === null) return;
  const changed = await db.update(routerUpdates).set({ dispatched: 1, ...(content ? { content_dispatched: 1 } : {}), updated_at: nowSec() })
    .where(ownedUpdate(ctx)).run();
  if (changed.rowsAffected !== 1) throw new Error('UPDATE_LEASE_LOST');
}

export async function beginDeliveryRecovery(ctx) {
  const id = updateId(ctx);
  if (id === null) return null;
  const now = nowSec(), token = crypto.randomUUID();
  const current = await db.select().from(routerUpdates).where(eq(routerUpdates.update_id, id)).get();
  if (!current || current.operation_kind !== 'delivery' || current.content_dispatched
    || !['unknown', 'in_progress'].includes(current.state)
    || (current.state === 'in_progress' && current.lease_until > now)) return null;
  const op = await db.select().from(deliveryOperations).where(and(eq(deliveryOperations.id, current.operation_id),
    eq(deliveryOperations.state, 'active'), sql`expires_at > ${now}`)).get();
  if (!op) return null;
  // This is a dedicated state-machine recovery, never a replay of the generic
  // handler. Any canonical confirmed or uncertain item blocks this pre-send
  // recovery route. Unknown content needs explicit domain reconciliation.
  const proof = sql`EXISTS (SELECT 1 FROM delivery_operations WHERE id = ${op.id} AND state = 'active' AND expires_at > ${now})
    AND NOT EXISTS (SELECT 1 FROM delivery_items WHERE attempt_id = ${op.attempt_id}
      AND state IN ('confirmed', 'dispatching', 'unknown'))
    AND NOT EXISTS (SELECT 1 FROM delivery_attempts WHERE id = ${op.attempt_id} AND lease_until > ${now})`;
  const changed = await db.update(routerUpdates).set({ state: 'in_progress', token,
    lease_until: now + UPDATE_LEASE_SECONDS, updated_at: now,
  }).where(and(eq(routerUpdates.update_id, id), eq(routerUpdates.token, current.token),
    eq(routerUpdates.content_dispatched, 0), eq(routerUpdates.operation_id, op.id),
    sql`(state = 'unknown' OR (state = 'in_progress' AND lease_until <= ${now}))`, proof)).run();
  if (changed.rowsAffected !== 1) return null;
  seenUpdates.delete(id);
  ctx.router_update_token = token;
  return op.id;
}

export async function finishUpdate(ctx, error = null) {
  if (!ctx?.router_update_token || updateId(ctx) === null) return;
  const current = await db.select().from(routerUpdates).where(ownedUpdate(ctx)).get();
  if (!current) return;
  let state = error ? (current.dispatched ? 'unknown' : 'retryable') : 'completed';
  if (ctx.router_recovery_deferred) state = 'unknown';
  if (current.operation_kind === 'delivery' && current.operation_id) {
    const attempt = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.operation_id, current.operation_id)).get();
    if (attempt) {
      const uncertain = await db.select({ id: deliveryItems.id }).from(deliveryItems).where(and(
        eq(deliveryItems.attempt_id, attempt.id), sql`state IN ('dispatching', 'unknown')`,
      )).limit(1).get();
      if (uncertain || attempt.state === 'unknown') state = 'unknown';
    }
  }
  if (current.operation_kind === 'upload' && current.operation_id) {
    const uncertain = await db.select({ id: uploadItems.id }).from(uploadItems).where(and(
      eq(uploadItems.session_id, current.operation_id), eq(uploadItems.update_id, current.update_id),
      sql`mirror_state IN ('pending', 'unknown')`,
    )).limit(1).get();
    if (uncertain) state = 'unknown';
  }
  const changed = await db.update(routerUpdates).set({ state, lease_until: 0, updated_at: nowSec() })
    .where(ownedUpdate(ctx)).run();
  if (changed.rowsAffected === 1 && ['completed', 'unknown'].includes(state)) {
    seenUpdates.add(updateId(ctx));
    if (seenUpdates.size > 2000) seenUpdates.delete(seenUpdates.keys().next().value);
  }
}

export async function recoverExpiredUpdates(now = nowSec(), limit = 25) {
  const expired = await db.select().from(routerUpdates).where(and(eq(routerUpdates.state, 'in_progress'),
    sql`lease_until <= ${now}`)).limit(Math.max(1, Math.min(25, Number(limit) || 25))).all();
  for (const row of expired) await db.update(routerUpdates).set({
    state: row.dispatched ? 'unknown' : 'retryable', lease_until: 0, updated_at: now,
  }).where(and(eq(routerUpdates.update_id, row.update_id), eq(routerUpdates.token, row.token),
    eq(routerUpdates.state, 'in_progress'), sql`lease_until <= ${now}`, eq(routerUpdates.dispatched, row.dispatched))).run();
  return expired.length;
}

export async function withUpdateLedger(ctx, dispatch, recover = null) {
  ctx ||= {};
  ctx.router_recovery_deferred = false;
  if (!await beginUpdate(ctx)) {
    if (!recover) return;
    const operationId = await beginDeliveryRecovery(ctx);
    if (!operationId) return;
    dispatch = (ownedCtx) => recover(ownedCtx, operationId);
  }
  try {
    const result = await dispatch(ctx);
    await finishUpdate(ctx);
    return result;
  } catch (error) {
    await finishUpdate(ctx, error).catch(() => {});
    throw error;
  }
}

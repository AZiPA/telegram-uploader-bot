import { db } from 'sdk';
import { and, eq, sql } from 'sdk/db';
import {
  deliveryOperations, deliveryAttempts, deliveryItems, deliveryQuotaAccounts,
  deliveryClaims, adminTestContinuations, routerUpdates,
} from '../../schema.js';
import { nowSec } from '../shared/config.js';
import {
  initializeDeliveryAttempt, acquireDeliveryAttempt, releaseDeliveryAttempt, deliveryReceipts,
  currentDeliveryBundle, projectDeliveryDeletionQueue, setDeliveryTerminal, recoverDeliveryTerminal,
} from '../filestore/delivery_state.js';
import { settleDeliveryAttempt } from '../filestore/delivery_accounting.js';

export const OPERATION_RETENTION_SECONDS = 30 * 86400;
const bounded = (limit) => Math.max(1, Math.min(25, Number(limit) || 25));

// These predicates are also used inside mutations. A preliminary read alone
// would leave a cross-isolate gap before rotation or physical expiry cleanup.
export function bundleMaintenanceGuard() {
  return sql`NOT EXISTS (SELECT 1 FROM delivery_operations AS active_delivery
    WHERE active_delivery.bundle_id = bundles.upload_session_id AND active_delivery.state IN ('active', 'unknown'))
    AND NOT EXISTS (SELECT 1 FROM delivery_attempts AS active_attempt
      WHERE active_attempt.bundle_id = bundles.upload_session_id AND
      (active_attempt.state IN ('active', 'paused', 'unknown') OR active_attempt.quota_state = 'reserved'
        OR active_attempt.one_time_state = 'claimed'))
    AND NOT EXISTS (SELECT 1 FROM upload_sessions AS active_upload
      WHERE (active_upload.id = bundles.upload_session_id OR active_upload.bundle_id = bundles.upload_session_id)
        AND ((active_upload.state IN ('starting', 'open') AND EXISTS (SELECT 1 FROM admin_sessions AS pointer
          WHERE pointer.session_id = active_upload.id AND pointer.state = 'active'
            AND pointer.updated_at > ${nowSec() - 86400}))
          OR EXISTS (SELECT 1 FROM router_updates AS running WHERE running.operation_kind = 'upload'
            AND running.operation_id = active_upload.id AND running.state = 'in_progress' AND running.lease_until > ${nowSec()})))
    AND NOT EXISTS (SELECT 1 FROM upload_items AS mirror JOIN upload_sessions AS upload ON upload.id = mirror.session_id
      WHERE (upload.id = bundles.upload_session_id OR upload.bundle_id = bundles.upload_session_id)
        AND mirror.mirror_state IN ('pending', 'unknown'))`;
}

export function queueMaintenanceGuard() {
  return sql`NOT EXISTS (SELECT 1 FROM delivery_items AS receipt
    JOIN delivery_attempts AS attempt ON attempt.id = receipt.attempt_id
    WHERE receipt.id = deletion_queue.delivery_receipt_id AND
      (attempt.state IN ('active', 'paused', 'unknown') OR attempt.quota_state = 'reserved'
        OR attempt.one_time_state = 'claimed' OR receipt.state != 'confirmed' OR receipt.queue_state = 'pending'))`;
}

export async function recoverExpiredDeliveries(now = nowSec(), limit = 25) {
  const operations = await db.select().from(deliveryOperations).where(and(
    eq(deliveryOperations.state, 'active'), sql`expires_at <= ${now}`,
    sql`NOT EXISTS (SELECT 1 FROM delivery_attempts WHERE id = delivery_operations.attempt_id AND lease_until > ${now})`,
  )).limit(bounded(limit)).all();
  let recovered = 0;
  for (const op of operations) {
    const attempt = await initializeDeliveryAttempt(op);
    if (await recoverDeliveryTerminal(op, attempt)) {
      await settleDeliveryAttempt(attempt, await currentDeliveryBundle(op), { terminal: attempt.state !== 'unknown' });
      await projectDeliveryDeletionQueue(op);
      recovered++;
      continue;
    }
    const owner = await acquireDeliveryAttempt(op);
    if (!owner) continue;
    try {
      const receipts = await deliveryReceipts(op.attempt_id);
      const unknown = receipts.some((item) => ['dispatching', 'unknown'].includes(item.state));
      await settleDeliveryAttempt(attempt, await currentDeliveryBundle(op), { terminal: !unknown, owner });
      await projectDeliveryDeletionQueue(op);
      await setDeliveryTerminal(op, unknown ? 'unknown' : 'aborted', owner);
      recovered++;
    } finally { await releaseDeliveryAttempt(op, owner); }
  }
  return recovered;
}

function accountPrunable(now) {
  const cutoff = now - OPERATION_RETENTION_SECONDS;
  const period = new Date(cutoff * 1000).toISOString().slice(0, 10);
  // Frozen bases can be shared by rotated/reused-code audit rows. Keep an
  // entire accounting group whenever any sibling still has a live retry path.
  return sql`period < ${period} AND updated_at < ${cutoff}
    AND NOT EXISTS (SELECT 1 FROM delivery_attempts AS attempt
      WHERE attempt.user_id = delivery_quota_accounts.user_id AND attempt.period = delivery_quota_accounts.period
      AND (attempt.state NOT IN ('complete', 'failed', 'aborted') OR attempt.quota_state = 'reserved'
        OR attempt.one_time_state = 'claimed' OR attempt.lease_until > ${now}
        OR EXISTS (SELECT 1 FROM delivery_items WHERE attempt_id = attempt.id AND
          (state IN ('dispatching', 'unknown') OR queue_state = 'pending'))
        OR EXISTS (SELECT 1 FROM delivery_operations WHERE id = attempt.operation_id AND
          (state NOT IN ('complete', 'failed', 'aborted', 'pruned') OR expires_at >= ${cutoff}))))
    AND NOT EXISTS (SELECT 1 FROM delivery_quota_accounts AS sibling
      JOIN delivery_attempts AS live ON live.user_id = sibling.user_id AND live.period = sibling.period
      WHERE delivery_quota_accounts.audit_row_id > 0 AND sibling.audit_row_id = delivery_quota_accounts.audit_row_id
        AND (live.state NOT IN ('complete', 'failed', 'aborted') OR live.quota_state = 'reserved'
          OR live.one_time_state = 'claimed' OR live.lease_until > ${now}))`;
}

function operationEvidencePrunable(now) {
  const currentPeriod = new Date(now * 1000).toISOString().slice(0, 10);
  return sql`NOT EXISTS (SELECT 1 FROM delivery_attempts AS attempt WHERE attempt.id = delivery_operations.attempt_id
      AND (attempt.state NOT IN ('complete', 'failed', 'aborted') OR attempt.quota_state = 'reserved'
        OR attempt.one_time_state = 'claimed' OR attempt.lease_until > ${now}
        OR (attempt.period >= ${currentPeriod} AND attempt.quota_state = 'consumed')
        OR EXISTS (SELECT 1 FROM delivery_quota_accounts WHERE user_id = attempt.user_id AND period = attempt.period)
        OR EXISTS (SELECT 1 FROM delivery_claims WHERE attempt_id = attempt.id)
        OR EXISTS (SELECT 1 FROM delivery_items AS receipt WHERE receipt.attempt_id = attempt.id
          AND (receipt.state IN ('dispatching', 'unknown') OR receipt.queue_state = 'pending'
            OR EXISTS (SELECT 1 FROM deletion_queue WHERE delivery_receipt_id = receipt.id)))))
    AND NOT EXISTS (SELECT 1 FROM delivery_claims WHERE attempt_id = delivery_operations.attempt_id)
    AND NOT EXISTS (SELECT 1 FROM delivery_items AS receipt WHERE receipt.attempt_id = delivery_operations.attempt_id
      AND (receipt.state IN ('dispatching', 'unknown') OR receipt.queue_state = 'pending'
        OR EXISTS (SELECT 1 FROM deletion_queue WHERE delivery_receipt_id = receipt.id)
        OR (receipt.state = 'confirmed' AND NOT EXISTS (SELECT 1 FROM delivery_attempts
          WHERE id = delivery_operations.attempt_id))))
    AND NOT EXISTS (SELECT 1 FROM router_updates WHERE operation_kind = 'delivery'
      AND operation_id = delivery_operations.id AND state IN ('in_progress', 'unknown', 'retryable'))`;
}

function operationPrunable(now) {
  const cutoff = now - OPERATION_RETENTION_SECONDS;
  return sql`delivery_operations.state IN ('complete', 'failed', 'aborted')
    AND delivery_operations.expires_at < ${cutoff} AND delivery_operations.updated_at < ${cutoff}
    AND ${operationEvidencePrunable(now)}`;
}

export async function pruneOperationalLedgers(now = nowSec(), limit = 25) {
  const cap = bounded(limit), cutoff = now - OPERATION_RETENTION_SECONDS;
  let accounts = 0, operations = 0, continuations = 0;
  const oldAccounts = await db.select({ id: deliveryQuotaAccounts.id }).from(deliveryQuotaAccounts)
    .where(accountPrunable(now)).limit(cap).all();
  for (const account of oldAccounts) {
    const changed = await db.delete(deliveryQuotaAccounts).where(and(eq(deliveryQuotaAccounts.id, account.id), accountPrunable(now))).run();
    accounts += changed.rowsAffected;
  }
  // A released claim is not consumption evidence. Its stable Bundle tombstone
  // and expired operation must already make every valid claim retry impossible.
  const released = await db.select({ bundle_id: deliveryClaims.bundle_id }).from(deliveryClaims).where(sql`
    state = 'released' AND updated_at < ${cutoff}
    AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = delivery_claims.bundle_id AND state = 'deleted')
    AND NOT EXISTS (SELECT 1 FROM bundles WHERE upload_session_id = delivery_claims.bundle_id)
    AND NOT EXISTS (SELECT 1 FROM delivery_operations WHERE bundle_id = delivery_claims.bundle_id
      AND (expires_at >= ${cutoff} OR state NOT IN ('complete', 'failed', 'aborted', 'pruned')))`)
    .limit(cap).all();
  for (const claim of released) await db.delete(deliveryClaims).where(and(eq(deliveryClaims.bundle_id, claim.bundle_id), eq(deliveryClaims.state, 'released'),
    sql`updated_at < ${cutoff} AND NOT EXISTS (SELECT 1 FROM delivery_operations WHERE bundle_id = ${claim.bundle_id}
      AND (expires_at >= ${cutoff} OR state NOT IN ('complete', 'failed', 'aborted', 'pruned')))`)).run();

  const terminal = await db.select().from(deliveryOperations).where(operationPrunable(now)).limit(cap).all();
  for (const op of terminal) {
    // First fence all retry paths with a retained operation/request tombstone.
    const retired = await db.update(deliveryOperations).set({ state: 'pruned', items: sql`'[]'`, updated_at: now })
      .where(and(eq(deliveryOperations.id, op.id), operationPrunable(now))).run();
    if (retired.rowsAffected !== 1) continue;
    operations++;
  }
  // Resume interrupted compaction, independently of which row was selected
  // above. Never delete a canonical uncertain or unattached receipt.
  const compacted = await db.select().from(deliveryOperations).where(and(eq(deliveryOperations.state, 'pruned'),
    operationEvidencePrunable(now),
    sql`(EXISTS (SELECT 1 FROM delivery_attempts WHERE id = delivery_operations.attempt_id)
      OR EXISTS (SELECT 1 FROM delivery_items WHERE attempt_id = delivery_operations.attempt_id))`)).limit(cap).all();
  for (const op of compacted) {
    await db.delete(deliveryItems).where(and(eq(deliveryItems.attempt_id, op.attempt_id),
      sql`state NOT IN ('dispatching', 'unknown') AND queue_state != 'pending'
        AND NOT EXISTS (SELECT 1 FROM deletion_queue WHERE delivery_receipt_id = delivery_items.id)
        AND NOT EXISTS (SELECT 1 FROM delivery_claims WHERE attempt_id = ${op.attempt_id})
        AND EXISTS (SELECT 1 FROM delivery_operations WHERE id = ${op.id} AND state = 'pruned'
          AND ${operationEvidencePrunable(now)})`)).run();
    await db.delete(deliveryAttempts).where(and(eq(deliveryAttempts.id, op.attempt_id),
      sql`state IN ('complete', 'failed', 'aborted') AND quota_state != 'reserved' AND one_time_state != 'claimed'
        AND NOT EXISTS (SELECT 1 FROM delivery_items WHERE attempt_id = ${op.attempt_id})
        AND NOT EXISTS (SELECT 1 FROM delivery_claims WHERE attempt_id = ${op.attempt_id})
        AND NOT EXISTS (SELECT 1 FROM delivery_quota_accounts WHERE user_id = delivery_attempts.user_id AND period = delivery_attempts.period)
        AND EXISTS (SELECT 1 FROM delivery_operations WHERE id = ${op.id} AND state = 'pruned'
          AND ${operationEvidencePrunable(now)})`)).run();
  }
  const expiredTokens = await db.select({ operation_id: adminTestContinuations.operation_id }).from(adminTestContinuations)
    .where(sql`expires_at < ${cutoff} AND NOT EXISTS (SELECT 1 FROM delivery_operations
      WHERE admin_test_id = admin_test_continuations.operation_id AND state != 'pruned')`).limit(cap).all();
  for (const token of expiredTokens) {
    const changed = await db.delete(adminTestContinuations).where(and(eq(adminTestContinuations.operation_id, token.operation_id),
      sql`expires_at < ${cutoff} AND NOT EXISTS (SELECT 1 FROM delivery_operations
        WHERE admin_test_id = ${token.operation_id} AND state != 'pruned')`)).run();
    continuations += changed.rowsAffected;
  }
  // Router terminal keys, upload lifecycle tombstones and confirmed mirror
  // receipts remain required replay/provenance proofs. Do not erase them.
  const oldUpdates = await db.select({ update_id: routerUpdates.update_id }).from(routerUpdates).where(sql`
    state = 'completed' AND updated_at < ${cutoff} AND token != ''
      AND (operation_id = '' OR NOT EXISTS (SELECT 1 FROM delivery_operations
        WHERE id = router_updates.operation_id AND state != 'pruned'))`).limit(cap).all();
  for (const update of oldUpdates) await db.update(routerUpdates).set({ token: '', lease_until: 0, operation_kind: '', operation_id: '' })
    .where(and(eq(routerUpdates.update_id, update.update_id), eq(routerUpdates.state, 'completed'), sql`updated_at < ${cutoff}`)).run();
  return { accounts, operations, continuations };
}

export async function fenceDeliveryReset(now = nowSec()) {
  // Fence dispatch immediately. Preserve uncertain receipts/claims/accounting;
  // the reset is not evidence that an already dispatched Telegram send failed.
  await db.update(routerUpdates).set({ state: 'unknown', lease_until: 0, updated_at: now })
    .where(eq(routerUpdates.state, 'in_progress')).run();
  await db.update(deliveryAttempts).set({ state: 'aborted', lease_owner: '', lease_until: 0, updated_at: now }).where(sql`
    state IN ('active', 'paused') AND NOT EXISTS (SELECT 1 FROM delivery_items
      WHERE attempt_id = delivery_attempts.id AND state IN ('dispatching', 'unknown'))`).run();
  await db.update(deliveryItems).set({ state: 'unknown', updated_at: now }).where(eq(deliveryItems.state, 'dispatching')).run();
  await db.update(deliveryAttempts).set({ state: 'unknown', lease_owner: '', lease_until: 0, updated_at: now }).where(sql`
    state IN ('active', 'paused') AND EXISTS (SELECT 1 FROM delivery_items
      WHERE attempt_id = delivery_attempts.id AND state = 'unknown')`).run();
  await db.update(deliveryOperations).set({ state: sql`CASE WHEN EXISTS (SELECT 1 FROM delivery_attempts
    WHERE id = delivery_operations.attempt_id AND state = 'unknown') THEN 'unknown' ELSE 'aborted' END`, updated_at: now })
    .where(eq(deliveryOperations.state, 'active')).run();
  const unsettled = await db.select().from(deliveryAttempts).where(sql`state IN ('aborted', 'unknown')`).all();
  for (const attempt of unsettled) await settleDeliveryAttempt(attempt, null, { terminal: attempt.state !== 'unknown' });
}

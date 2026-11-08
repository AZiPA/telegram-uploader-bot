import { db } from 'sdk';
import { and, eq, isNull, sql } from 'sdk/db';
import { bundles, bundleVotes, uploadSessions, adminSessions } from '../../schema.js';
import { nowSec } from '../shared/config.js';

// The upload operation is also the Bundle's lifecycle identity. Public codes
// can rotate; a deleted operation is retained permanently as a tombstone.
export function bundleAvailable() {
  return sql`NOT EXISTS (SELECT 1 FROM upload_sessions AS lifecycle
    WHERE lifecycle.id = bundles.upload_session_id AND lifecycle.state = 'deleted')`;
}

export async function ensureBundleIdentity(bundle, database = db) {
  if (!bundle) return null;
  if (bundle.upload_session_id) return bundle;
  const id = crypto.randomUUID();
  const changed = await database.update(bundles).set({ upload_session_id: id })
    .where(and(eq(bundles.code, bundle.code), isNull(bundles.upload_session_id))).run();
  // Never re-resolve a failed identity claim through a possibly reused code.
  if (changed.rowsAffected !== 1) return null;
  return { ...bundle, upload_session_id: id };
}

export async function cleanupDeletedBundle(id, guard = sql`1`) {
  // Cleanup is repeatable, and cannot touch a different Bundle reusing a code.
  await db.delete(bundleVotes).where(sql`code IN (SELECT code FROM bundles
    WHERE upload_session_id = ${id} AND ${guard}) AND EXISTS (SELECT 1 FROM upload_sessions
    WHERE id = ${id} AND state = 'deleted')`).run();
  const cleaned = await db.delete(bundles).where(and(eq(bundles.upload_session_id, id),
    sql`EXISTS (SELECT 1 FROM upload_sessions WHERE id = ${id} AND state = 'deleted')`, guard)).run();
  await db.update(adminSessions).set({ state: 'deleted', revision: sql`revision + 1` }).where(and(
    eq(adminSessions.session_id, id), sql`state != 'deleted'`,
    sql`EXISTS (SELECT 1 FROM upload_sessions WHERE id = ${id} AND state = 'deleted'
      AND generation = admin_sessions.generation)`,
  )).run();
  return cleaned;
}

// Used by explicit deletion, expiry, and completed One-Time cleanup. An optional
// Bundle predicate (authorization/expiry) is evaluated in the tombstone write.
export async function deleteBundle(bundle, guard = sql`1`) {
  bundle = await ensureBundleIdentity(bundle);
  if (!bundle) return false;
  const id = bundle.upload_session_id;
  // Legacy Bundles acquire a lifecycle in the existing ledger, never a second
  // tombstone system. Phase 1 uploads already have this row.
  await db.insert(uploadSessions).values({
    id, admin_id: bundle.created_by, generation: id, mode: 'legacy',
    bundle_code: bundle.code, result_code: bundle.code, state: 'complete',
    created_at: bundle.created_at || nowSec(), updated_at: nowSec(),
  }).onConflictDoNothing({ target: uploadSessions.id }).run();
  const changed = await db.update(uploadSessions).set({ state: 'deleted',
    revision: sql`revision + 1`, updated_at: nowSec() }).where(and(
    eq(uploadSessions.id, id), sql`state IN ('open', 'finalizing', 'complete')`,
    sql`EXISTS (SELECT 1 FROM bundles WHERE upload_session_id = ${id} AND ${guard})`,
  )).run();
  const lifecycle = await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).get();
  if (changed.rowsAffected !== 1 && lifecycle?.state !== 'deleted') return false;
  await cleanupDeletedBundle(id);
  return true;
}

// Also permits a known upload identity to be retired before its first insert.
// No SELECT/INSERT gap: this transition and the conditional Bundle INSERT both
// arbitrate on the same durable row at SQLite statement execution time.
export async function deleteUploadOperation(id) {
  const changed = await db.update(uploadSessions).set({ state: 'deleted',
    revision: sql`revision + 1`, updated_at: nowSec() }).where(and(
    eq(uploadSessions.id, id), sql`state IN ('open', 'finalizing', 'complete')`,
  )).run();
  const op = await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).get();
  if (changed.rowsAffected !== 1 && op?.state !== 'deleted') return false;
  await cleanupDeletedBundle(id);
  return true;
}

export async function recoverDeletedBundles(guard = sql`1`) {
  // Scan physical remnants, not the permanently growing tombstone ledger.
  const remnants = await db.select({ id: bundles.upload_session_id }).from(bundles)
    .where(and(sql`EXISTS (SELECT 1 FROM upload_sessions AS lifecycle
      WHERE lifecycle.id = bundles.upload_session_id AND lifecycle.state = 'deleted')`, guard)).limit(25).all();
  for (const row of remnants) {
    const safe = await db.select({ id: bundles.upload_session_id }).from(bundles)
      .where(and(eq(bundles.upload_session_id, row.id), guard)).get();
    if (safe) await cleanupDeletedBundle(row.id, guard);
  }
}

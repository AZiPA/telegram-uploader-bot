import { canManageBundle, getBundle } from '../helpers.js';
import { db } from 'sdk';
import { eq, and, sql } from 'sdk/db';
import { admins, systemConfig, bundles } from '../../schema.js';
import { bundleAvailable } from './lifecycle.js';

export { canManageBundle };

export async function getManagedBundle(code, role, userId) {
  const row = await getBundle(code);
  const allowed = Boolean(row && (await canManageBundle(role, userId, row)));
  return { row, allowed };
}

// Mutation decisions must not reuse an isolate's cached role or owner identity.
export async function getFreshAdminRole(userId, database = db) {
  const numericId = Number(userId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return 'user';
  const owner = await database.select().from(systemConfig).where(eq(systemConfig.key, 'owner_id')).get();
  if (Number(owner?.value) === numericId) return 'owner';
  const admin = await database.select().from(admins).where(eq(admins.user_id, numericId)).get();
  if (admin?.role === 'owner') return 'admin';
  if (admin?.role === 'superadmin' || admin?.role === 'super_admin') return 'super_admin';
  return admin?.role === 'admin' ? 'admin' : 'user';
}

// Used inside a Bundle UPDATE's WHERE clause, so a revocation or ownership
// change before SQLite executes the write cannot race a preceding read.
export function bundleMutationGuard(userId) {
  const numericId = Number(userId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return sql`0`;
  return sql`${bundleAvailable()} AND (
    EXISTS (SELECT 1 FROM system_config WHERE "key" = 'owner_id' AND CAST(value AS INTEGER) = ${numericId})
    OR (
      EXISTS (SELECT 1 FROM admins WHERE user_id = ${numericId} AND role IN ('owner', 'admin', 'super_admin', 'superadmin'))
      AND (${bundles.owner_locked} = 0 OR ${bundles.created_by} = ${numericId})
    )
  )`;
}

export async function getManagedBundleFresh(code, userId, database = db) {
  const role = await getFreshAdminRole(userId, database);
  const row = await database.select().from(bundles).where(and(eq(bundles.code, code), bundleMutationGuard(userId))).get();
  const allowed = Boolean(row && await canManageBundle(role, userId, row));
  return { row, allowed, role };
}

import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { adminTestContinuations, bundles } from '../../schema.js';
import { generateBase62Code } from '../shared/crypto.js';
import { nowSec } from '../shared/config.js';
import { getManagedBundleFresh, bundleMutationGuard } from '../bundles/permissions.js';
import { ensureBundleIdentity } from '../bundles/lifecycle.js';

const TOKEN_PATTERN = /^[0-9A-Za-z]{22}$/;
const OPERATION_TTL = 900;

export async function createAdminTestOperation(userId, chatId, bundleCode, database = db) {
  if (!Number.isSafeInteger(Number(chatId)) || !Number(chatId)) return null;
  const access = await getManagedBundleFresh(bundleCode, userId, database);
  if (!access.allowed) return null;
  const bundle = await ensureBundleIdentity(access.row, database);
  if (!bundle) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const operation = {
      operation_id: generateBase62Code(22),
      user_id: Number(userId),
      chat_id: Number(chatId),
      bundle_code: bundle.code,
      bundle_id: bundle.upload_session_id,
      expires_at: nowSec() + OPERATION_TTL,
    };
    const result = await database.insert(adminTestContinuations).values(operation)
      .onConflictDoNothing({ target: adminTestContinuations.operation_id }).run();
    if (result?.rowsAffected === 1) return operation;
  }
  return null;
}

export async function resolveAdminTestOperation(operationId, userId, chatId, bundleCode = null, database = db) {
  if (typeof operationId !== 'string' || !TOKEN_PATTERN.test(operationId)) return null;
  const operation = await database.select().from(adminTestContinuations)
    .where(eq(adminTestContinuations.operation_id, operationId)).get();
  if (!operation || Number(operation.user_id) !== Number(userId) || Number(operation.chat_id) !== Number(chatId) ||
      Number(operation.expires_at) <= nowSec() || !operation.bundle_id) return null;
  // Tokens created before stable binding fail closed. Resolving a mutable old
  // code could grant trusted test exemptions to an unrelated replacement.
  const bundle = await database.select().from(bundles).where(and(
    eq(bundles.upload_session_id, operation.bundle_id), bundleMutationGuard(userId),
  )).get();
  if (!bundle || (bundleCode !== null && bundleCode !== operation.bundle_code && bundleCode !== bundle.code)) return null;
  return { ...operation, bundle_code: bundle.code };
}

export function adminTestCallback(operationId, offset) {
  if (!TOKEN_PATTERN.test(operationId) || !Number.isInteger(offset) || offset < 0 || offset >= 25) {
    throw new Error('Invalid Admin Test continuation');
  }
  // ASCII only: 7-byte prefix + 22-byte token + ':' + up to two digits.
  return `dl:p:t:${operationId}:${offset}`;
}

export function parseAdminTestCallback(data) {
  const match = /^dl:p:t:([0-9A-Za-z]{22}):(0|[1-9][0-9]?)$/.exec(data);
  if (!match || Number(match[2]) >= 25) return null;
  return { operationId: match[1], offset: Number(match[2]) };
}

import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { bundles, adminSessions, userSessions } from '../../schema.js';
import { nowSec } from './config.js';
import { sendMsg, buildForceReply } from './telegram.js';
import { getRoleLevel } from '../middlewares/auth.js';
import { checkPinLockout, recordPinStrike, resetPinStrikes as resetStrikesQuota } from '../middlewares/rate_limiter.js';

export async function clearAdminSession(userId) {
  return db.delete(adminSessions).where(eq(adminSessions.admin_id, Number(userId))).run();
}

export async function clearUserSession(userId) {
  return db.delete(userSessions).where(eq(userSessions.user_id, Number(userId))).run();
}

export async function getAdminSession(adminId) {
  return db.select().from(adminSessions).where(eq(adminSessions.admin_id, Number(adminId))).get();
}

export async function setAdminPrompt(chatIdOrUserId, userIdOrCode, sessionOrMode, promptText = null, placeholderText = '') {
  if (promptText === null && typeof sessionOrMode === 'string') {
    const adminId = Number(chatIdOrUserId);
    const code = userIdOrCode;
    const mode = sessionOrMode;
    const now = nowSec();
    return db.insert(adminSessions).values({
      admin_id: adminId,
      code,
      mode,
      items: '[]',
      updated_at: now,
    }).onConflictDoUpdate({
      target: adminSessions.admin_id,
      set: {
        code,
        mode,
        items: '[]',
        updated_at: now,
      },
    }).run();
  }
  const chatId = chatIdOrUserId;
  const adminId = Number(userIdOrCode);
  const { code, mode, items = [] } = sessionOrMode || {};
  const serializedItems = typeof items === 'string' ? items : JSON.stringify(items || []);
  const now = nowSec();
  await db.insert(adminSessions).values({
    admin_id: adminId,
    code,
    mode,
    items: serializedItems,
    updated_at: now,
  }).onConflictDoUpdate({
    target: adminSessions.admin_id,
    set: {
      code,
      mode,
      items: serializedItems,
      updated_at: now,
    },
  }).run();
  return sendMsg(chatId, promptText, buildForceReply(placeholderText));
}

export async function getBundle(code) {
  return db.select().from(bundles).where(eq(bundles.code, code)).get();
}

export async function canManageBundle(role, userId, bundle) {
  if (!bundle) return false;
  const userLevel = getRoleLevel(role);
  if (userLevel < 2) return false;

  const isLocked = Boolean(bundle.owner_locked);
  if (!isLocked) {
    return true;
  }

  return userLevel >= 4 || bundle.created_by === userId || Number(bundle.created_by) === Number(userId);
}

export async function recordPinFailure(userId, sessionAttempts = 0) {
  const result = await recordPinStrike(userId, db, sessionAttempts);
  if (result.isLockedOut) {
    await clearUserSession(userId);
  }
  return result;
}

export async function resetPinStrikes(userId) {
  return resetStrikesQuota(userId, db);
}

export async function isUserPinLockedOut(userId) {
  const result = await checkPinLockout(userId, db);
  return Boolean(result.locked);
}

export async function grantBundleAccess(userId, bundleCode) {
  const now = Math.floor(Date.now() / 1000);
  const numUserId = Number(userId);

  const activeSession = await db.select().from(userSessions)
    .where(eq(userSessions.user_id, numUserId))
    .get();

  const hadActiveFailures = Boolean(
    activeSession &&
    activeSession.code === bundleCode &&
    (activeSession.attempts || 0) > 0
  );

  await db.insert(userSessions).values({
    user_id: numUserId,
    code: bundleCode,
    mode: 'unlocked_grant',
    attempts: 0,
    updated_at: now,
  }).onConflictDoUpdate({
    target: userSessions.user_id,
    set: {
      code: bundleCode,
      mode: 'unlocked_grant',
      attempts: 0,
      updated_at: now,
    },
  }).run();

  if (hadActiveFailures) {
    await resetPinStrikes(numUserId);
  }
}

export async function hasBundleAccessGrant(userId, bundleCode) {
  const now = Math.floor(Date.now() / 1000);
  const numUserId = Number(userId);
  const grant = await db.select().from(userSessions)
    .where(and(
      eq(userSessions.user_id, numUserId),
      eq(userSessions.code, bundleCode),
      eq(userSessions.mode, 'unlocked_grant')
    ))
    .get();
  const grantUpdatedAt = grant?.updated_at ?? grant?.updatedAt ?? 0;
  if (grant && (now - grantUpdatedAt <= 900)) {
    await db.update(userSessions).set({ updated_at: now }).where(eq(userSessions.user_id, numUserId)).run();
    return true;
  }
  return false;
}

import { db as defaultDb } from 'sdk';
import { eq, sql } from 'sdk/db';
import { userQuotas } from '../../schema.js';
import { nowSec, getConfig } from '../shared/config.js';
import { getRoleLevel } from './auth.js';
import { LIMITS } from '../shared/constants.js';

const MAX_STRIKES = LIMITS?.MAX_PIN_STRIKES || 5;
const LOCKOUT_DURATION_SEC = 1800;

export { MAX_STRIKES, LOCKOUT_DURATION_SEC };

const floodMemoryMap = new Map();

export async function checkUserFlood(userId, db = defaultDb) {
  const numUserId = Number(userId);
  if (!numUserId) return { limited: false };

  const floodThresholdSec = Number(await getConfig('flood_threshold_sec', '1')) || 1;
  const now = nowSec();

  const lastMsgAt = floodMemoryMap.get(numUserId) || 0;
  if (lastMsgAt && (now - lastMsgAt < floodThresholdSec)) {
    const elapsedSec = now - lastMsgAt;
    const retryAfter = Math.max(500, (floodThresholdSec - elapsedSec) * 1000);
    return { limited: true, retryAfter };
  }

  floodMemoryMap.set(numUserId, now);

  // Periodically evict stale keys if map exceeds 5000 users
  if (floodMemoryMap.size > 5000) {
    const cutoff = now - 60;
    for (const [uid, ts] of floodMemoryMap.entries()) {
      if (ts < cutoff) floodMemoryMap.delete(uid);
    }
  }

  return { limited: false };
}

export async function checkDownloadQuota(userId, role, db = defaultDb) {
  const numUserId = Number(userId);
  if (!numUserId) return { allowed: true, remaining: Infinity };

  // 1. Direct Owner & Privilege Guard
  const ownerId = await getConfig('owner_id');
  const isOwner = (ownerId && Number(ownerId) === numUserId) || role === 'owner';
  const isPrivileged = isOwner || role === 'vip' || (role && getRoleLevel(role) >= 2);
  if (isPrivileged) {
    return { allowed: true, remaining: Infinity };
  }

  const dbInstance = (db && typeof db.select === 'function') ? db : defaultDb;
  const dailyLimitConfig = Number(await getConfig('daily_download_cap', '0')) || 0;
  const DAILY_DOWNLOAD_LIMIT = dailyLimitConfig > 0 ? dailyLimitConfig : (LIMITS?.DEFAULT_DAILY_DOWNLOAD_LIMIT || 0);

  if (DAILY_DOWNLOAD_LIMIT <= 0) {
    return { allowed: true, remaining: Infinity };
  }

  const today = new Date().toISOString().slice(0, 10);
  const quota = await dbInstance.select({
    downloads_today: userQuotas.downloads_today,
    last_download_date: userQuotas.last_download_date,
  }).from(userQuotas).where(eq(userQuotas.user_id, numUserId)).get();

  const countToday = (quota && quota.last_download_date === today)
    ? Number(quota.downloads_today || 0)
    : 0;

  if (countToday >= DAILY_DOWNLOAD_LIMIT) {
    return { allowed: false, limit: DAILY_DOWNLOAD_LIMIT };
  }

  return { allowed: true, remaining: DAILY_DOWNLOAD_LIMIT - countToday };
}

export async function consumeDownloadQuota(userId, db = defaultDb) {
  const dbInstance = (db && typeof db.insert === 'function') ? db : defaultDb;
  const numUserId = Number(userId);
  const now = nowSec();
  const today = new Date().toISOString().slice(0, 10);

  return await dbInstance.insert(userQuotas).values({
    user_id: numUserId,
    downloads_today: 1,
    last_download_date: today,
    last_request_at: now,
    strikes: 0,
    banned_until: 0,
  }).onConflictDoUpdate({
    target: userQuotas.user_id,
    set: {
      downloads_today: sql`CASE WHEN last_download_date = ${today} THEN downloads_today + 1 ELSE 1 END`,
      last_download_date: today,
      last_request_at: now,
    },
  }).run();
}

export const incrementUserQuota = consumeDownloadQuota;

export async function rollbackDownloadQuota(userId, db = defaultDb) {
  const dbInstance = (db && typeof db.update === 'function') ? db : defaultDb;
  const numUserId = Number(userId);
  const today = new Date().toISOString().slice(0, 10);

  return await dbInstance.update(userQuotas).set({
    downloads_today: sql`CASE WHEN last_download_date = ${today} AND downloads_today > 0 THEN downloads_today - 1 ELSE downloads_today END`,
  }).where(eq(userQuotas.user_id, numUserId)).run();
}

export async function checkPinLockout(userId, db = defaultDb) {
  const dbInstance = (db && typeof db.select === 'function') ? db : defaultDb;
  const numUserId = Number(userId);
  if (!numUserId) return { locked: false, remainingAttempts: MAX_STRIKES };

  const quota = await dbInstance.select({
    strikes: userQuotas.strikes,
    banned_until: userQuotas.banned_until,
  }).from(userQuotas).where(eq(userQuotas.user_id, numUserId)).get();

  if (quota?.banned_until === -1) {
    return { locked: true, permanent: true };
  }

  const now = nowSec();
  if (quota?.banned_until && quota.banned_until > now) {
    return { locked: true, permanent: false, retryAfter: quota.banned_until - now };
  }

  const strikes = Number(quota?.strikes || 0);
  if (strikes >= MAX_STRIKES) {
    const retryAfter = LOCKOUT_DURATION_SEC;
    const bannedUntil = now + retryAfter;
    await dbInstance.update(userQuotas).set({
      banned_until: bannedUntil,
      strikes: 0,
    }).where(eq(userQuotas.user_id, numUserId)).run();
    return { locked: true, permanent: false, retryAfter };
  }

  return { locked: false, remainingAttempts: Math.max(0, MAX_STRIKES - strikes) };
}

export async function recordPinStrike(userId, dbOrAttempts = defaultDb, sessionAttempts = 0) {
  let dbInstance = defaultDb;
  let attempts = sessionAttempts;
  if (typeof dbOrAttempts === 'number') {
    attempts = dbOrAttempts;
  } else if (dbOrAttempts && typeof dbOrAttempts.select === 'function') {
    dbInstance = dbOrAttempts;
  }

  const now = nowSec();
  const numUserId = Number(userId);
  const today = new Date().toISOString().slice(0, 10);

  const existingQuota = await dbInstance.select({
    strikes: userQuotas.strikes,
    last_request_at: userQuotas.last_request_at,
  }).from(userQuotas).where(eq(userQuotas.user_id, numUserId)).get();

  const windowExpired = existingQuota && existingQuota.last_request_at && (now - existingQuota.last_request_at > 1800);
  const nextStrikes = (!existingQuota || windowExpired) ? 1 : sql`strikes + 1`;

  await dbInstance.insert(userQuotas).values({
    user_id: numUserId,
    downloads_today: 0,
    last_download_date: today,
    last_request_at: now,
    strikes: 1,
    banned_until: 0,
  }).onConflictDoUpdate({
    target: userQuotas.user_id,
    set: {
      strikes: nextStrikes,
      last_request_at: now,
    },
  }).run();

  const quota = await dbInstance.select({
    strikes: userQuotas.strikes,
    banned_until: userQuotas.banned_until,
  }).from(userQuotas).where(eq(userQuotas.user_id, numUserId)).get();

  const totalStrikes = Number(quota?.strikes || 0);
  const isLockedOut = attempts >= 3 || totalStrikes >= MAX_STRIKES;

  if (isLockedOut) {
    const existingBan = Number(quota?.banned_until || 0);
    const newBannedUntil = existingBan === -1 ? -1 : Math.max(existingBan, now + LOCKOUT_DURATION_SEC);
    await dbInstance.update(userQuotas).set({
      banned_until: newBannedUntil,
      strikes: 0,
    }).where(eq(userQuotas.user_id, numUserId)).run();
  }

  return { isLockedOut, locked: isLockedOut, totalStrikes, strikes: totalStrikes };
}

export async function resetPinStrikes(userId, db = defaultDb) {
  const dbInstance = (db && typeof db.update === 'function') ? db : defaultDb;
  const numUserId = Number(userId);
  return await dbInstance.update(userQuotas).set({
    strikes: 0,
    banned_until: 0,
  }).where(eq(userQuotas.user_id, numUserId)).run();
}

export async function isUserPinLockedOut(userId, db = defaultDb) {
  const lockout = await checkPinLockout(userId, db);
  return Boolean(lockout.locked);
}

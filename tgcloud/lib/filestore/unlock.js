import {
  db, eq, userSessions,
  sendMsg, buildForceReply, clearUserSession, nowSec, escapeHtml,
  verifyBundlePin, grantBundleAccess, hasBundleAccessGrant
} from '../helpers.js';
import {
  checkPinLockout,
  recordPinStrike,
  resetPinStrikes as resetPinStrikesRateLimiter,
  isUserPinLockedOut as isUserPinLockedOutRateLimiter
} from '../middlewares/rate_limiter.js';
import { t } from '../locales/index.js';

export async function isUserPinLockedOut(userId) {
  return isUserPinLockedOutRateLimiter(userId, db);
}

export async function resetPinStrikes(userId) {
  return resetPinStrikesRateLimiter(userId, db);
}

export async function recordPinFailure(userId, sessionAttempts = 0) {
  const result = await recordPinStrike(userId, db, sessionAttempts);
  if (result.isLockedOut) {
    await clearUserSession(userId);
  }
  return result;
}

export {
  verifyBundlePin,
  clearUserSession,
  grantBundleAccess,
  hasBundleAccessGrant,
};

export const grantPinUnlock = grantBundleAccess;
export const hasValidUnlockGrant = hasBundleAccessGrant;

export async function checkUserBan(userId, chatId = null, lang = 'en') {
  const lockout = await checkPinLockout(userId, db);
  if (!lockout.locked) return false;
  if (lockout.permanent) {
    if (chatId) await sendMsg(chatId, t(lang, 'rate_limit_permanent'));
    return { banned: true, permanent: true };
  }
  const min = Math.max(1, Math.ceil((lockout.retryAfter || 0) / 60));
  if (chatId) await sendMsg(chatId, t(lang, 'rate_limit_temp', { min }));
  return { banned: true, permanent: false, min };
}

export async function promptBundlePinUnlock(chatId, userId, code, lang) {
  const now = nowSec();
  await db.insert(userSessions).values({
    user_id: Number(userId),
    code,
    mode: 'unlock_pass',
    attempts: 0,
    updated_at: now,
  }).onConflictDoUpdate({
    target: userSessions.user_id,
    set: {
      code,
      mode: 'unlock_pass',
      attempts: 0,
      updated_at: now,
    },
  }).run();
  return sendMsg(
    chatId,
    t(lang, 'passcode_prompt', { code: escapeHtml(code) }),
    buildForceReply(t(lang, 'passcode_placeholder'))
  );
}

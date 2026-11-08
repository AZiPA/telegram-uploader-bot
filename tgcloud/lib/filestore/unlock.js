import { db, sendMsg } from '../helpers.js';
import { checkPinLockout } from '../middlewares/rate_limiter.js';
import { t } from '../locales/index.js';

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

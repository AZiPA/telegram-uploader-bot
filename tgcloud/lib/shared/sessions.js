import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { bundles, adminSessions, userSessions } from '../../schema.js';
import { nowSec } from './config.js';
import { sendMsg, buildForceReply } from './telegram.js';
import { getRoleLevel } from '../middlewares/auth.js';

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

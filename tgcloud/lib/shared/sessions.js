import { db } from 'sdk';
import { eq, and, isNull, sql } from 'sdk/db';
import { bundles, adminSessions, userSessions } from '../../schema.js';
import { nowSec, parseItems } from './config.js';
import { sendMsg, buildForceReply } from './telegram.js';
import { getRoleLevel } from '../middlewares/auth.js';
import { bundleAvailable } from '../bundles/lifecycle.js';

const SESSION_CAS_ATTEMPTS = 4;

export function sessionFence(snapshot) {
  const match = (column, value) => value === null || value === undefined ? isNull(column) : eq(column, value);
  return and(
    eq(adminSessions.admin_id, Number(snapshot.admin_id)),
    match(adminSessions.session_id, snapshot.session_id),
    match(adminSessions.generation, snapshot.generation),
    match(adminSessions.state, snapshot.state),
    match(adminSessions.mode, snapshot.mode),
    match(adminSessions.code, snapshot.code),
    match(adminSessions.revision, snapshot.revision)
  );
}

export function sessionIdentityActive(snapshot) {
  if (!snapshot) return sql`0`;
  return sql`EXISTS (SELECT 1 FROM admin_sessions WHERE ${sessionFence(snapshot)})`;
}

export async function clearAdminSession(userId, expected = null, database = db) {
  const snapshot = expected || await getAdminSession(userId, database);
  if (!snapshot || Number(snapshot.admin_id) !== Number(userId)) return { rowsAffected: 0 };
  return database.delete(adminSessions).where(sessionFence(snapshot)).run();
}

// Upload activity lives in the durable operation. Check it in the same delete
// statement so an acceptance racing expiry cannot lose its active pointer.
export async function clearExpiredAdminSession(snapshot, cutoff, database = db) {
  return database.delete(adminSessions).where(and(sessionFence(snapshot),
    sql`${adminSessions.updated_at} <= ${cutoff}`,
    sql`NOT EXISTS (SELECT 1 FROM upload_sessions WHERE id = ${snapshot.session_id || ''}
      AND generation = ${snapshot.generation || ''}
      AND (state = 'finalizing' OR (state = 'open' AND updated_at > ${cutoff})))`,
  )).run();
}

export async function replaceAdminSession(userId, values, database = db, expected = undefined) {
  for (let attempt = 0; attempt < SESSION_CAS_ATTEMPTS; attempt++) {
    const previous = expected === undefined ? await getAdminSession(userId, database) : expected;
    const next = {
      admin_id: Number(userId),
      code: String(values.code || ''),
      mode: values.mode || null,
      items: parseItems(values.items || []),
      session_id: values.session_id || crypto.randomUUID(),
      generation: values.generation || crypto.randomUUID(),
      state: values.state || 'active',
      revision: Number(previous?.revision || 0) + 1,
      updated_at: nowSec(),
    };
    const rows = previous
      ? await database.update(adminSessions).set(next).where(sessionFence(previous)).returning().run()
      : await database.insert(adminSessions).values(next).onConflictDoNothing({ target: adminSessions.admin_id }).returning().run();
    if (rows.length === 1) return rows[0];
    if (expected !== undefined) return null;
  }
  throw new Error('Admin session replacement contention');
}

export async function updateAdminSession(snapshot, changes, database = db) {
  const next = { ...changes, revision: Number(snapshot.revision || 0) + 1, updated_at: nowSec() };
  delete next.admin_id;
  if ((changes.mode !== undefined && changes.mode !== snapshot.mode) || (changes.code !== undefined && changes.code !== snapshot.code)) {
    next.session_id = crypto.randomUUID();
    next.generation = crypto.randomUUID();
  }
  const rows = await database.update(adminSessions).set(next).where(sessionFence(snapshot)).returning().run();
  return rows.length === 1 ? rows[0] : null;
}

export async function rebindAdminSessions(oldCode, newCode, database = db) {
  const sessions = await database.select().from(adminSessions).where(eq(adminSessions.code, oldCode)).all();
  for (const initial of sessions) {
    let snapshot = initial;
    let rebound = false;
    for (let attempt = 0; attempt < SESSION_CAS_ATTEMPTS && snapshot?.code === oldCode; attempt++) {
      if (await updateAdminSession(snapshot, { code: newCode }, database)) {
        rebound = true;
        break;
      }
      snapshot = await getAdminSession(initial.admin_id, database);
    }
    if (!rebound && snapshot?.code === oldCode) throw new Error('Admin session rebind contention');
  }
}

export async function clearUserSession(userId) {
  return db.delete(userSessions).where(eq(userSessions.user_id, Number(userId))).run();
}

export async function getAdminSession(adminId, database = db) {
  return database.select().from(adminSessions).where(eq(adminSessions.admin_id, Number(adminId))).get();
}

export async function setAdminPrompt(chatIdOrUserId, userIdOrCode, sessionOrMode, promptText = null, placeholderText = '') {
  if (promptText === null && typeof sessionOrMode === 'string') {
    const adminId = Number(chatIdOrUserId);
    const code = userIdOrCode;
    const mode = sessionOrMode;
    return replaceAdminSession(adminId, { code, mode, items: '[]' });
  }
  const chatId = chatIdOrUserId;
  const adminId = Number(userIdOrCode);
  const { code, mode, items = [] } = sessionOrMode || {};
  await replaceAdminSession(adminId, { code, mode, items });
  return sendMsg(chatId, promptText, buildForceReply(placeholderText));
}

export async function getBundle(code) {
  return db.select().from(bundles).where(and(eq(bundles.code, code), bundleAvailable())).get();
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

import {
  db, eq, sql, count,
  admins, vips, userQuotas,
  getRoleLevel, getUserRole, getEffectiveOwnerId, escapeHtml, LIMITS
} from '../helpers.js';
import { t } from '../locales/index.js';
import { sendMsg, clearAdminSession, nowSec } from '../helpers.js';
import { buildVipsKeyboard, renderAdminsPanel, renderVipsPanel } from './members_panel.js';

let cachedAdmins = null;
let cachedAdminsExpiresAt = 0;

export function invalidateAdminsCache() {
  cachedAdmins = null;
  cachedAdminsExpiresAt = 0;
}

export async function getAdmins() {
  if (cachedAdmins && Date.now() < cachedAdminsExpiresAt) {
    return cachedAdmins;
  }
  const rows = await db.select().from(admins).all();
  cachedAdmins = rows || [];
  cachedAdminsExpiresAt = Date.now() + 15000;
  return cachedAdmins;
}

let cachedVips = null;
let cachedVipsExpiresAt = 0;

export function invalidateVipsCache() {
  cachedVips = null;
  cachedVipsExpiresAt = 0;
}

export async function getVips() {
  if (cachedVips && Date.now() < cachedVipsExpiresAt) {
    return cachedVips;
  }
  const rows = await db.select().from(vips).all();
  cachedVips = rows || [];
  cachedVipsExpiresAt = Date.now() + 15000;
  return cachedVips;
}

export async function isAdmin(userId) {
  const adminList = await getAdmins();
  const numId = Number(userId);
  return adminList.some((a) => Number(a.user_id) === numId);
}

export async function addAdmin(targetId, addedBy, targetRole = 'admin') {
  const res = await db.insert(admins).values({
    user_id: Number(targetId),
    added_by: Number(addedBy),
    role: targetRole,
    created_at: nowSec(),
  }).onConflictDoUpdate({
    target: admins.user_id,
    set: { role: targetRole },
  }).run();
  invalidateAdminsCache();
  return res;
}

export async function removeAdmin(targetId) {
  const res = await db.delete(admins).where(eq(admins.user_id, Number(targetId))).run();
  invalidateAdminsCache();
  return res;
}

export async function handleMembersCommand(cmd, arg, message, userId, chatId, lang, role) {
  if (cmd === '/admins') {
    return renderAdminsPanel({ chatId, lang, role });
  }

  if (cmd === '/addadmin') {
    const callerLevel = getRoleLevel(role);
    if (callerLevel < 3) return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    if (!arg) return sendMsg(chatId, t(lang, 'admin_prompt_add'));
    const parts = arg.trim().split(/\s+/), targetId = Number(parts[0]), rawRole = (parts[1] || 'admin').toLowerCase();
    if (!targetId || Number.isNaN(targetId) || targetId <= 0) return sendMsg(chatId, t(lang, 'admin_invalid_id'));
    let targetRole;
    if (rawRole === 'owner') {
      return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));
    } else if (rawRole === 'superadmin' || rawRole === 'super_admin') {
      targetRole = 'super_admin';
    } else if (rawRole === 'admin') {
      targetRole = 'admin';
    } else {
      return sendMsg(chatId, t(lang, 'admin_prompt_add'));
    }
    if (targetRole === 'super_admin' && callerLevel < 4) {
      return sendMsg(chatId, t(lang, 'superadmin_cannot_add_superadmin'));
    }
    const ownerId = await getEffectiveOwnerId();
    if (targetId === ownerId) {
      return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));
    }
    const existingAdmin = await db.select().from(admins).where(eq(admins.user_id, targetId)).get();
    if (existingAdmin) {
      const existingLevel = getRoleLevel(existingAdmin.role);
      if (existingLevel >= callerLevel) {
        if (existingLevel === 3) {
          return sendMsg(chatId, t(lang, 'superadmin_cannot_remove_superadmin'));
        }
        return sendMsg(chatId, t(lang, 'superadmin_only_command'));
      }
    } else {
      const admCount = (await db.select({ c: count() }).from(admins).get())?.c || 0;
      if (admCount >= LIMITS.MAX_ADMINS) return sendMsg(chatId, t(lang, 'admin_limit_reached', { max: LIMITS.MAX_ADMINS }));
    }
    await addAdmin(targetId, userId, targetRole);
    return sendMsg(chatId, t(lang, 'admin_added_success', { id: targetId, role: escapeHtml(targetRole) }));
  }

  if (cmd === '/deladmin') {
    const callerLevel = getRoleLevel(role);
    if (callerLevel < 3) return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    const targetId = Number(arg?.trim());
    if (!targetId || Number.isNaN(targetId) || targetId <= 0) return sendMsg(chatId, t(lang, 'deladmin_usage'));
    const ownerId = await getEffectiveOwnerId();
    if (targetId === ownerId) return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));
    const target = await db.select({ role: admins.role }).from(admins).where(eq(admins.user_id, targetId)).get();
    if (!target) return sendMsg(chatId, t(lang, 'admin_not_found', { id: targetId }));
    if (target.role === 'owner') return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));
    const targetLevel = getRoleLevel(target.role);
    if (targetLevel >= callerLevel) {
      if (targetLevel === 3) {
        return sendMsg(chatId, t(lang, 'superadmin_cannot_remove_superadmin'));
      }
      return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    }
    await removeAdmin(targetId);
    return sendMsg(chatId, t(lang, 'admin_removed_success', { id: targetId }));
  }

  if (cmd === '/vips') {
    return renderVipsPanel({ chatId, lang });
  }

  if (cmd === '/addvip') {
    if (!arg?.trim()) return sendMsg(chatId, t(lang, 'addvip_usage'));
    const parts = arg.trim().split(/\s+/);
    if (!parts[0] || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= 0) {
      return sendMsg(chatId, t(lang, 'addvip_usage'));
    }
    const vId = Number(parts[0]);

    let days = 0;
    if (parts[1] !== undefined && parts[1] !== '0') {
      if (!/^[1-9]\d*$/.test(parts[1])) {
        return sendMsg(chatId, t(lang, 'addvip_usage'));
      }
      days = Number(parts[1]);
    }

    const now = nowSec();
    const exp = days > 0 ? now + days * 86400 : 0;
    const term = days > 0 ? t(lang, 'vip_days', { days }) : t(lang, 'vip_lifetime');
    await db.insert(vips).values({
      user_id: vId,
      added_by: Number(userId),
      expires_at: exp,
      created_at: now,
    }).onConflictDoUpdate({
      target: vips.user_id,
      set: {
        expires_at: exp,
        added_by: Number(userId),
      },
    }).run();
    invalidateVipsCache();
    return sendMsg(chatId, t(lang, 'addvip_applied', { id: vId, term }));
  }

  if (cmd === '/delvip') {
    if (!arg?.trim()) return sendMsg(chatId, t(lang, 'delvip_usage'));
    if (arg.trim().toLowerCase() === 'all') {
      const callerLevel = getRoleLevel(role);
      if (callerLevel < 3) return sendMsg(chatId, t(lang, 'superadmin_only_command'));
      return sendMsg(chatId, t(lang, 'btn_vips_clear_all'), { reply_markup: buildVipsKeyboard(lang, { confirmClear: true }) });
    }
    const vId = Number(arg.trim());
    if (!vId) return sendMsg(chatId, t(lang, 'delvip_usage'));
    const res = await db.delete(vips).where(eq(vips.user_id, vId)).run();
    const affected = res?.rowsAffected ?? 0;
    if (affected === 0) return sendMsg(chatId, t(lang, 'vip_not_found', { id: vId }));
    invalidateVipsCache();
    return sendMsg(chatId, t(lang, 'delvip_applied', { id: vId }));
  }

  if (cmd === '/clearvips') {
    const callerLevel = getRoleLevel(role);
    if (callerLevel < 3) return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    return sendMsg(chatId, t(lang, 'btn_vips_clear_all'), { reply_markup: buildVipsKeyboard(lang, { confirmClear: true }) });
  }

  if (cmd === '/ban') {
    const parts = (arg || '').trim().split(/\s+/), bId = Number(parts[0]);
    if (!bId || Number.isNaN(bId) || bId <= 0) return sendMsg(chatId, t(lang, 'ban_usage'));

    let days = 30;
    if (parts[1] !== undefined) {
      const parsedDays = Number(parts[1]);
      if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 3650) {
        return sendMsg(chatId, t(lang, 'ban_usage'));
      }
      days = parsedDays;
    }

    const ownerId = await getEffectiveOwnerId();
    if (bId === ownerId) return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));

    const callerLevel = getRoleLevel(role);
    const targetRole = await getUserRole(bId);
    if (targetRole === 'owner') return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));

    const targetLevel = getRoleLevel(targetRole);
    if (targetLevel >= 4) {
      return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));
    }
    if (targetLevel >= 3) {
      return sendMsg(chatId, t(lang, 'superadmin_cannot_remove_superadmin'));
    }
    if (targetLevel >= callerLevel) {
      return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    }

    const now = nowSec();
    const banUntil = now + days * 86400;
    await db.insert(userQuotas).values({
      user_id: bId,
      last_download_date: sql`date('now')`,
      banned_until: banUntil,
    }).onConflictDoUpdate({
      target: userQuotas.user_id,
      set: { banned_until: banUntil },
    }).run();
    return sendMsg(chatId, t(lang, 'ban_applied', { id: bId, days }));
  }

  if (cmd === '/unban') {
    const uId = Number(arg?.trim());
    if (!uId) return sendMsg(chatId, t(lang, 'unban_usage'));
    await db.update(userQuotas).set({ banned_until: 0, strikes: 0 }).where(eq(userQuotas.user_id, uId)).run();
    return sendMsg(chatId, t(lang, 'unban_applied', { id: uId }));
  }

  return false;
}

export async function handleMembersPrompt(session, text, userId, chatId, lang) {
  if (session.mode !== 'add_admin') return false;

  await clearAdminSession(userId);

  const callerRole = await getUserRole(userId);
  const callerLevel = getRoleLevel(callerRole);
  if (callerLevel < 3) return sendMsg(chatId, t(lang, 'superadmin_only_command'));

  const parts = (text || '').trim().split(/\s+/), targetId = Number(parts[0]), rawRole = (parts[1] || 'admin').toLowerCase();
  if (!targetId || Number.isNaN(targetId) || targetId <= 0) return sendMsg(chatId, t(lang, 'admin_invalid_id'));

  let targetRole;
  if (rawRole === 'owner') {
    return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));
  } else if (rawRole === 'superadmin' || rawRole === 'super_admin') {
    targetRole = 'super_admin';
  } else if (rawRole === 'admin') {
    targetRole = 'admin';
  } else {
    return sendMsg(chatId, t(lang, 'admin_prompt_add'));
  }

  if (targetRole === 'super_admin' && callerLevel < 4) {
    return sendMsg(chatId, t(lang, 'superadmin_cannot_add_superadmin'));
  }

  const ownerId = await getEffectiveOwnerId();
  if (targetId === ownerId) {
    return sendMsg(chatId, t(lang, 'admin_cannot_manage_owner'));
  }

  const existingAdmin = await db.select().from(admins).where(eq(admins.user_id, targetId)).get();
  if (existingAdmin) {
    const existingLevel = getRoleLevel(existingAdmin.role);
    if (existingLevel >= callerLevel) {
      if (existingLevel === 3) {
        return sendMsg(chatId, t(lang, 'superadmin_cannot_remove_superadmin'));
      }
      return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    }
  } else {
    const adminCount = (await db.select({ c: count() }).from(admins).get())?.c || 0;
    if (adminCount >= LIMITS.MAX_ADMINS) return sendMsg(chatId, t(lang, 'admin_limit_reached', { max: LIMITS.MAX_ADMINS }));
  }

  await addAdmin(targetId, userId, targetRole);
  return sendMsg(chatId, t(lang, 'admin_added_success', { id: targetId, role: escapeHtml(targetRole) }));
}

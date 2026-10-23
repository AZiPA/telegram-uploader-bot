import { db, eq, and, or, sql, systemConfig, vips, getConfig, configCache } from '../helpers.js';
import { getAdmins } from '../admin/members.js';

export const ROLE_LEVELS = {
  owner: 4,
  super_admin: 3,
  superadmin: 3,
  admin: 2,
  vip: 1,
  user: 0,
};

export function getRoleLevel(role) {
  return ROLE_LEVELS[role] ?? 0;
}

export async function claimOwnerAtomically(userId) {
  const strId = String(userId);
  let claimed = false;
  try {
    await db.insert(systemConfig).values({ key: 'owner_id', value: strId }).run();
    claimed = true;
  } catch {}

  if (!claimed) {
    try {
      const res = await db.update(systemConfig)
        .set({ value: strId })
        .where(and(
          eq(systemConfig.key, 'owner_id'),
          or(eq(systemConfig.value, '0'), eq(systemConfig.value, ''))
        ))
        .run();
      const affected = res?.rowsAffected ?? 0;
      if (affected === 1) {
        claimed = true;
      }
    } catch {}
  }

  if (claimed) {
    configCache.set('owner_id', { raw: strId, exp: Math.floor(Date.now() / 1000) + 60 });
  }
  return claimed;
}

export async function getEffectiveOwnerId() {
  const cfgOwner = await getConfig('owner_id', null);
  const numCfgOwner = cfgOwner ? Number(cfgOwner) : 0;
  if (numCfgOwner > 0) return numCfgOwner;

  try {
    const cfgRow = await db.select().from(systemConfig).where(eq(systemConfig.key, 'owner_id')).get();
    if (cfgRow?.value && Number(cfgRow.value) > 0) {
      const ownerId = Number(cfgRow.value);
      configCache.set('owner_id', { raw: String(ownerId), exp: Math.floor(Date.now() / 1000) + 60 });
      return ownerId;
    }
  } catch {}

  return 0;
}

export async function getUserRole(userId) {
  if (!userId) return 'user';
  const numericId = Number(userId);
  if (!numericId || numericId <= 0) return 'user';

  const ownerId = await getEffectiveOwnerId();
  if (ownerId > 0 && String(numericId) === String(ownerId)) return 'owner';

  try {
    const adminList = await getAdmins();
    const adminRow = adminList?.find((a) => Number(a.user_id) === numericId);
    if (adminRow?.role) {
      if (adminRow.role === 'owner') return 'admin';
      if (adminRow.role === 'superadmin' || adminRow.role === 'super_admin') return 'super_admin';
      return adminRow.role;
    }
  } catch {}

  try {
    const now = Math.floor(Date.now() / 1000);
    const vipRow = await db.select().from(vips).where(
      and(
        eq(vips.user_id, numericId),
        or(eq(vips.expires_at, 0), sql`${vips.expires_at} > ${now}`)
      )
    ).get();
    if (vipRow) return 'vip';
  } catch {}

  return 'user';
}

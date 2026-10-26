import {
  db as defaultDb,
  eq,
  admins,
  systemConfig,
  vips,
  sendMsg,
  nowSec,
  configCache
} from '../helpers.js';
import { invalidateAdminsCache } from './members.js';
import { t } from '../locales/index.js';

/**
 * Consolidates Zero-State bootstrapping via Telegram command.
 * Checks if any owner currently exists in system_config or admins.
 * If none exists, atomically claims ownership and registers the user.
 */
export async function handleZeroStateClaim(database, userId, userLang = 'en', chatId = null) {
  const activeDb = database || defaultDb;
  const numericId = Number(userId);
  if (!numericId || Number.isNaN(numericId) || numericId <= 0) {
    throw new Error('Invalid userId provided for zero-state claim');
  }

  // Check if an owner already exists in system_config
  const cfgOwnerRow = await activeDb.select().from(systemConfig).where(eq(systemConfig.key, 'owner_id')).get();
  const cfgOwner = cfgOwnerRow?.value ? Number(cfgOwnerRow.value) : 0;

  // Check if an owner already exists in admins
  const adminOwnerRow = await activeDb.select().from(admins).where(eq(admins.role, 'owner')).get();
  const adminOwner = adminOwnerRow?.user_id ? Number(adminOwnerRow.user_id) : 0;

  if (cfgOwner > 0 || adminOwner > 0) {
    const alreadyMsg = t(userLang, 'claimowner_already_claimed');
    if (chatId) {
      try {
        await sendMsg(chatId, alreadyMsg);
      } catch (_) {}
    }
    return { success: false, message: alreadyMsg, alreadyClaimed: true };
  }

  const strId = String(numericId);
  const now = nowSec();

  // Atomically register owner_id in system_config
  await activeDb.insert(systemConfig)
    .values({ key: 'owner_id', value: strId })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: strId },
    })
    .run();

  // Atomically register userId as owner in admins
  await activeDb.insert(admins)
    .values({
      user_id: numericId,
      added_by: numericId,
      role: 'owner',
      created_at: now,
    })
    .onConflictDoUpdate({
      target: admins.user_id,
      set: { role: 'owner', added_by: numericId },
    })
    .run();

  // Invalidate in-memory caches
  invalidateAdminsCache();
  configCache.clear();

  const successMsg = t(userLang, 'claimowner_success');
  if (chatId) {
    try {
      await sendMsg(chatId, successMsg);
    } catch (err) {
      console.warn('[ownership_bootstrap] Telegram sendMessage skipped/failed during bootstrap:', err?.message || err);
    }
  }

  return { success: true, message: successMsg };
}

/**
 * Unconditionally enforces the bot owner from CI/CD bootstrap (--ctx '{"ci_bootstrap":true}').
 * Reassigns dependent records, cleans previous owners, and updates caches idempotently.
 * Zero user ID logging enforced for public template security.
 */
export async function enforceBootstrapOwner(ownerIdRaw) {
  const ownerId = Number(ownerIdRaw);
  if (!ownerId || Number.isNaN(ownerId) || ownerId <= 0 || !Number.isSafeInteger(ownerId)) {
    console.error('[ownership_bootstrap] Invalid or missing OWNER_ID provided in bootstrap payload');
    return { success: false, error: 'INVALID_OWNER_ID' };
  }

  const strId = String(ownerId);
  const now = nowSec();

  const oldOwnerRow = await defaultDb.select().from(systemConfig).where(eq(systemConfig.key, 'owner_id')).get();
  const oldOwnerId = oldOwnerRow?.value ? Number(oldOwnerRow.value) : 0;

  if (oldOwnerId > 0 && oldOwnerId !== ownerId) {
    // 1. Reassign child admins and VIPs created by old owner
    await defaultDb.update(admins)
      .set({ added_by: ownerId })
      .where(eq(admins.added_by, oldOwnerId))
      .run();

    await defaultDb.update(vips)
      .set({ added_by: ownerId })
      .where(eq(vips.added_by, oldOwnerId))
      .run();

    // 2. Remove old owner completely from admins
    await defaultDb.delete(admins)
      .where(eq(admins.user_id, oldOwnerId))
      .run();
  }

  // 3. Atomically upsert the owner in admins table
  await defaultDb.insert(admins)
    .values({
      user_id: ownerId,
      added_by: ownerId,
      role: 'owner',
      created_at: now,
    })
    .onConflictDoUpdate({
      target: admins.user_id,
      set: { role: 'owner', added_by: ownerId },
    })
    .run();

  // 4. Atomically upsert owner_id in system_config
  await defaultDb.insert(systemConfig)
    .values({ key: 'owner_id', value: strId })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: strId },
    })
    .run();

  // 5. Invalidate caches
  invalidateAdminsCache();
  configCache.clear();

  console.log('[ownership_bootstrap] CI/CD Bootstrap: Bot Owner enforced successfully.');
  return { success: true };
}

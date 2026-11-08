import { and, eq, lte, gt, inArray, isNotNull, sql } from 'sdk/db';
import {
  db,
  bundles, bundleVotes, deletionQueue, userDownloads,
  userSessions, adminSessions, vips, systemConfig,
  tgApi, generateBundleCode, getConfig, getBotUsername,
  nowSec, parseItems, escapeHtml
} from '../helpers.js';
import { buildChannelPostKeyboard } from '../shared/buttons.js';
import { clearExpiredAdminSession, rebindAdminSessions } from '../shared/sessions.js';
import { sendLogAlert } from '../services/log_channel.js';
import { deleteBundle, bundleAvailable, ensureBundleIdentity, recoverDeletedBundles } from '../bundles/lifecycle.js';
import { bundleMaintenanceGuard, queueMaintenanceGuard, recoverExpiredDeliveries, pruneOperationalLedgers } from './operational_maintenance.js';
import { recoverExpiredUpdates } from './update_ledger.js';

let lastMaintAt = 0;
const MAINT_INTERVAL = 30;
const SESSION_TTL = 86400;
const MAINT_LEASE_SECONDS = 180;

async function claimMaintenanceLease(now) {
  await db.insert(systemConfig).values({ key: 'maintenance_lease', value: '0' })
    .onConflictDoNothing({ target: systemConfig.key }).run();
  const current = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, 'maintenance_lease')).get();
  if (!current || Number(String(current.value).split(':')[0]) > now) return null;
  const raw = `${now + MAINT_LEASE_SECONDS}:${crypto.randomUUID()}`;
  const changed = await db.update(systemConfig).set({ value: raw }).where(and(
    eq(systemConfig.key, 'maintenance_lease'), eq(systemConfig.value, current.value),
  )).run();
  return changed.rowsAffected === 1 ? { raw } : null;
}

function maintenanceLeaseGuard(lease) {
  return sql`EXISTS (SELECT 1 FROM system_config WHERE key = 'maintenance_lease'
    AND value = ${lease.raw} AND CAST(value AS INTEGER) > ${nowSec()})`;
}

export async function runOpportunisticMaintenance(ctx) {
  let lease = null;
  try {
    const now = nowSec();
    if (now - lastMaintAt < MAINT_INTERVAL) return;

    const updated = await db
      .update(systemConfig)
      .set({ value: String(now) })
      .where(
        and(
          eq(systemConfig.key, 'last_maint_at'),
          sql`CAST(value AS INTEGER) <= ${now - MAINT_INTERVAL}`
        )
      )
      .run();
    lastMaintAt = now;
    if (!updated || updated.rowsAffected === 0) {
      const row = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, 'last_maint_at')).get();
      if (!row) {
        await db.insert(systemConfig).values({ key: 'last_maint_at', value: '0' }).onConflictDoNothing().run().catch(() => {});
      }
      return; // Another concurrent isolate is already running or ran maintenance
    }
    lease = await claimMaintenanceLease(now);
    if (!lease) return;

    try {
      await recoverExpiredUpdates(now);
      await recoverExpiredDeliveries(now);
      await recoverDeletedBundles(and(bundleMaintenanceGuard(), maintenanceLeaseGuard(lease)));
      await pruneOperationalLedgers(now);
      let deletedMsgCount = 0;
      const queue = await db.select().from(deletionQueue).where(and(lte(deletionQueue.delete_at, now), queueMaintenanceGuard(), maintenanceLeaseGuard(lease))).limit(25).all();
      if (queue?.length) {
        const idsToDelete = [];
        const BATCH_SIZE = 5;
        for (let i = 0; i < queue.length; i += BATCH_SIZE) {
          const wave = queue.slice(i, i + BATCH_SIZE);
          await Promise.all(
            wave.map(async (item) => {
              try {
                const ready = await db.select({ id: deletionQueue.id }).from(deletionQueue)
                  .where(and(eq(deletionQueue.id, item.id), lte(deletionQueue.delete_at, now), queueMaintenanceGuard(), maintenanceLeaseGuard(lease))).get();
                if (!ready) return;
                const msgIds = parseItems(item.message_ids);
                if (Array.isArray(msgIds) && msgIds.length > 0) {
                  for (let j = 0; j < msgIds.length; j += 100) {
                    const chunk = msgIds.slice(j, j + 100);
                    await tgApi.deleteMessages({ chat_id: item.chat_id, message_ids: chunk });
                    deletedMsgCount += chunk.length;
                  }
                }
                idsToDelete.push(item.id);
              } catch (err) {
                const errCode = err?.code ?? err?.status;
                const desc = String(err?.description || err?.message || '').toLowerCase();
                const isPermanent =
                  errCode === 400 ||
                  errCode === 403 ||
                  desc.includes('not found') ||
                  desc.includes("can't be deleted") ||
                  desc.includes('chat not found') ||
                  desc.includes('blocked');
                if (isPermanent) {
                  idsToDelete.push(item.id);
                } else {
                  const retryAfter = Number(err?.parameters?.retry_after || 60);
                  await db.update(deletionQueue)
                    .set({ delete_at: now + retryAfter })
                    .where(eq(deletionQueue.id, item.id))
                    .run()
                    .catch((e) => console.error(e));
                }
              }
            })
          );
        }
        if (idsToDelete.length) await db.delete(deletionQueue).where(inArray(deletionQueue.id, idsToDelete)).run();
      }

      let expiredBundlesCount = 0;
      const expiredBundles = await db.select()
        .from(bundles)
        .where(and(
          gt(bundles.expires_at, 0),
          lte(bundles.expires_at, now), bundleAvailable(), bundleMaintenanceGuard(), maintenanceLeaseGuard(lease)
        ))
        .limit(25)
        .all();
      if (expiredBundles?.length) {
        expiredBundlesCount = expiredBundles.length;
        for (const b of expiredBundles) {
          await deleteBundle(b, and(gt(bundles.expires_at, 0), lte(bundles.expires_at, now), bundleMaintenanceGuard(), maintenanceLeaseGuard(lease)));
        }
      }

      await db.delete(userSessions).where(sql`user_id IN (SELECT user_id FROM user_sessions
        WHERE updated_at <= ${now - SESSION_TTL} LIMIT 25)`).run().catch((e) => console.error(e));
      const staleAdminSessions = await db.select().from(adminSessions).where(and(lte(adminSessions.updated_at, now - SESSION_TTL),
        sql`NOT EXISTS (SELECT 1 FROM upload_sessions WHERE id = admin_sessions.session_id AND state = 'finalizing')
          AND NOT EXISTS (SELECT 1 FROM upload_items WHERE session_id = admin_sessions.session_id AND mirror_state IN ('pending', 'unknown'))`)).limit(25).all();
      for (const session of staleAdminSessions) {
        await clearExpiredAdminSession(session, now - SESSION_TTL).catch((e) => console.error(e));
      }
      await db.delete(vips).where(sql`user_id IN (SELECT user_id FROM vips WHERE expires_at > 0 AND expires_at <= ${now} LIMIT 25)`).run().catch((e) => console.error(e));
      const cutoffDateStr = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
      await db.delete(userDownloads).where(sql`id IN (SELECT id FROM user_downloads WHERE access_date < ${cutoffDateStr}
        AND NOT EXISTS (SELECT 1 FROM delivery_quota_accounts AS account WHERE account.audit_row_id = user_downloads.id
          AND EXISTS (SELECT 1 FROM delivery_attempts WHERE user_id = account.user_id AND period = account.period
            AND (state IN ('active', 'paused', 'unknown') OR quota_state = 'reserved' OR one_time_state = 'claimed')))
        LIMIT 25)`).run().catch((e) => console.error(e));

      let rotatedCount = 0;
      const dueRotations = await db.select()
        .from(bundles)
        .where(and(
          gt(bundles.rotate_interval_sec, 0), bundleAvailable(), bundleMaintenanceGuard(), maintenanceLeaseGuard(lease),
          isNotNull(bundles.post_channel_id),
          lte(sql`${bundles.last_rotated_at} + ${bundles.rotate_interval_sec}`, now)
        ))
        .limit(5)
        .all();
      if (dueRotations?.length) {
        const botUsername = await getBotUsername();
        for (const candidate of dueRotations) {
          const item = await ensureBundleIdentity(candidate);
          if (!item) continue;
          const isProtected = Boolean(item.protect_content);
          let newCode = '';
          let rotated = false;
          let attempts = 0;
          while (!rotated && attempts < 3) {
            attempts++;
            newCode = generateBundleCode(isProtected);
            try {
              const res = await db.update(bundles)
                .set({ code: newCode, last_rotated_at: now })
                .where(and(eq(bundles.code, item.code), eq(bundles.upload_session_id, item.upload_session_id), bundleAvailable(), bundleMaintenanceGuard(), maintenanceLeaseGuard(lease)))
                .run();
              if ((res?.rowsAffected ?? 0) === 1) {
                rotated = true;
              } else {
                break;
              }
            } catch (err) {
              const msg = String(err?.message || err?.description || err || '');
              if (msg.includes('UNIQUE') || msg.includes('constraint')) {
                continue;
              }
              throw err;
            }
          }
          if (!rotated) continue;

          try { await db.update(bundleVotes).set({ code: newCode }).where(eq(bundleVotes.code, item.code)).run(); } catch (_) {}
          try { await db.update(userDownloads).set({ code: newCode }).where(eq(userDownloads.code, item.code)).run(); } catch (_) {}
          try { await rebindAdminSessions(item.code, newCode); } catch (_) {}

          const sysLang = (await getConfig('language')) || 'en';
          const kb = buildChannelPostKeyboard(sysLang, botUsername, newCode);
          try {
            await tgApi.editMessageReplyMarkup({ chat_id: item.post_channel_id, message_id: item.post_message_id, reply_markup: kb });
            rotatedCount++;
          } catch (e) {
            const errCode = e?.code ?? e?.status;
            const errDesc = String(e?.description || e?.message || '').toLowerCase();
            if (errDesc.includes('message is not modified')) {
              // ignore
            } else if (errCode === 400 || errCode === 403) {
              await db.update(bundles).set({ rotate_interval_sec: 0, post_channel_id: null, post_message_id: 0 }).where(and(
                eq(bundles.code, newCode), eq(bundles.upload_session_id, item.upload_session_id),
                eq(bundles.post_channel_id, item.post_channel_id), eq(bundles.post_message_id, item.post_message_id),
                bundleAvailable(), bundleMaintenanceGuard(), maintenanceLeaseGuard(lease),
              )).run();
            } else {
              console.error(e);
            }
          }
        }
      }

      if (deletedMsgCount > 0 || expiredBundlesCount > 0 || rotatedCount > 0) {
        const parts = [];
        if (deletedMsgCount > 0) parts.push(`Auto-deleted messages: ${deletedMsgCount}`);
        if (expiredBundlesCount > 0) parts.push(`Expired bundles pruned: ${expiredBundlesCount}`);
        if (rotatedCount > 0) parts.push(`Channel post links rotated: ${rotatedCount}`);
        await sendLogAlert('🔧 Maintenance Report', parts.join('\n'), tgApi, db);
      }
    } catch (err) {
      console.error(err);
      await sendLogAlert('🚨 Maintenance Error', escapeHtml(String(err?.description || err?.message || err)), tgApi, db);
    }
  } catch (err) {
    console.error('Opportunistic maintenance failed:', err);
  } finally {
    if (lease) await db.update(systemConfig).set({ value: '0' }).where(and(
      eq(systemConfig.key, 'maintenance_lease'), eq(systemConfig.value, lease.raw),
    )).run().catch(() => {});
  }
}

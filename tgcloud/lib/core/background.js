import { and, or, eq, lte, lt, gt, inArray, isNotNull, sql } from 'sdk/db';
import {
  db,
  bundles, bundleVotes, deletionQueue, userDownloads,
  userSessions, adminSessions, vips, systemConfig,
  tgApi, generateBundleCode, getConfig, setConfig, getBotUsername,
  nowSec, parseItems, escapeHtml
} from '../helpers.js';
import { buildChannelPostKeyboard } from '../shared/buttons.js';
import { sendLogAlert } from '../services/log_channel.js';

let lastMaintAt = 0;
const MAINT_INTERVAL = 30;
const SESSION_TTL = 86400;

export async function runOpportunisticMaintenance(ctx) {
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

    try {
      let deletedMsgCount = 0;
      const queue = await db.select().from(deletionQueue).where(lte(deletionQueue.delete_at, now)).limit(25).all();
      if (queue?.length) {
        const idsToDelete = [];
        const BATCH_SIZE = 5;
        for (let i = 0; i < queue.length; i += BATCH_SIZE) {
          const wave = queue.slice(i, i + BATCH_SIZE);
          await Promise.all(
            wave.map(async (item) => {
              try {
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
      const expiredBundles = await db.select({ code: bundles.code })
        .from(bundles)
        .where(and(
          gt(bundles.expires_at, 0),
          lte(bundles.expires_at, now)
        ))
        .limit(25)
        .all();
      if (expiredBundles?.length) {
        expiredBundlesCount = expiredBundles.length;
        for (const b of expiredBundles) {
          await db.delete(bundleVotes).where(eq(bundleVotes.code, b.code)).run();
          await db.delete(bundles).where(eq(bundles.code, b.code)).run();
        }
      }

      await db.delete(userSessions).where(lte(userSessions.updated_at, now - SESSION_TTL)).run().catch((e) => console.error(e));
      await db.delete(adminSessions).where(lte(adminSessions.updated_at, now - SESSION_TTL)).run().catch((e) => console.error(e));
      await db.delete(vips).where(and(gt(vips.expires_at, 0), lte(vips.expires_at, now))).run().catch((e) => console.error(e));
      const cutoffDateStr = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
      await db.delete(userDownloads).where(lt(userDownloads.access_date, cutoffDateStr)).run().catch((e) => console.error(e));

      let rotatedCount = 0;
      const dueRotations = await db.select({
        code: bundles.code,
        post_channel_id: bundles.post_channel_id,
        post_message_id: bundles.post_message_id,
        rotate_interval_sec: bundles.rotate_interval_sec,
        protect_content: bundles.protect_content,
      })
        .from(bundles)
        .where(and(
          gt(bundles.rotate_interval_sec, 0),
          isNotNull(bundles.post_channel_id),
          lte(sql`${bundles.last_rotated_at} + ${bundles.rotate_interval_sec}`, now)
        ))
        .limit(5)
        .all();
      if (dueRotations?.length) {
        const botUsername = await getBotUsername();
        for (const item of dueRotations) {
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
                .where(eq(bundles.code, item.code))
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

          await db.update(bundleVotes).set({ code: newCode }).where(eq(bundleVotes.code, item.code)).run();
          await db.update(userDownloads).set({ code: newCode }).where(eq(userDownloads.code, item.code)).run();
          await db.update(userSessions).set({ code: newCode }).where(eq(userSessions.code, item.code)).run();
          await db.update(adminSessions).set({ code: newCode }).where(eq(adminSessions.code, item.code)).run();

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
              await db.update(bundles).set({ rotate_interval_sec: 0, post_channel_id: null, post_message_id: 0 }).where(eq(bundles.code, newCode)).run();
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
  }
}

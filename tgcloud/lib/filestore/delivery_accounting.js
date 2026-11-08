import { db } from 'sdk';
import { and, eq, sql } from 'sdk/db';
import { bundles, deliveryAttempts, deliveryItems, deliveryClaims, deliveryQuotaAccounts, userQuotas, userDownloads } from '../../schema.js';
import { getConfig, nowSec } from '../shared/config.js';
import { LIMITS } from '../shared/constants.js';
import { bundleAvailable } from '../bundles/lifecycle.js';

const counted = sql`quota_state IN ('reserved', 'consumed')`;
const exemptRoles = new Set(['vip', 'admin', 'super_admin', 'superadmin', 'owner', 'admin_test']);
const dailyId = (attempt) => `daily:${attempt.user_id}:${attempt.period}`;
const linkId = (attempt) => `link:${attempt.user_id}:${attempt.bundle_id}:${attempt.period}`;

async function readAttempt(attempt) {
  return await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.id, attempt.id)).get();
}

async function initializeAccounts(attempt) {
  await db.insert(deliveryQuotaAccounts).values({
    id: dailyId(attempt), user_id: attempt.user_id, period: attempt.period,
    base_count: sql`COALESCE((SELECT downloads_today FROM user_quotas WHERE user_id = ${attempt.user_id}
      AND last_download_date = ${attempt.period}), 0)`, updated_at: nowSec(),
  }).onConflictDoNothing({ target: deliveryQuotaAccounts.id }).run();
  const bundle = await db.select({ code: bundles.code }).from(bundles).where(eq(bundles.upload_session_id, attempt.bundle_id)).get();
  const code = bundle?.code || attempt.quota_code;
  await db.insert(deliveryQuotaAccounts).values({
    id: linkId(attempt), user_id: attempt.user_id, period: attempt.period, bundle_id: attempt.bundle_id,
    quota_code: code, base_count: sql`COALESCE((SELECT download_count FROM user_downloads
      WHERE user_id = ${attempt.user_id} AND code = ${code} AND access_date = ${attempt.period}), 0)`,
    audit_row_id: sql`COALESCE((SELECT id FROM user_downloads
      WHERE user_id = ${attempt.user_id} AND code = ${code} AND access_date = ${attempt.period}), 0)`,
    updated_at: nowSec(),
  }).onConflictDoNothing({ target: deliveryQuotaAccounts.id }).run();
}

function dailyUsage(attempt) {
  return sql`COALESCE((SELECT base_count FROM delivery_quota_accounts WHERE id = ${dailyId(attempt)}), 0)
    + (SELECT COUNT(*) FROM delivery_attempts WHERE user_id = ${attempt.user_id} AND period = ${attempt.period} AND ${counted})`;
}

function linkUsage(attempt) {
  return sql`COALESCE((SELECT base_count FROM delivery_quota_accounts WHERE id = ${linkId(attempt)}), 0)
    + (SELECT COUNT(*) FROM delivery_attempts WHERE user_id = ${attempt.user_id} AND bundle_id = ${attempt.bundle_id}
      AND period = ${attempt.period} AND ${counted})`;
}

export async function reserveDeliveryQuota(attempt, role) {
  let current = await readAttempt(attempt);
  if (!current) return { allowed: false, reason: 'daily', attempt: null };
  if (current.quota_state === 'none' && exemptRoles.has(role)) {
    await db.update(deliveryAttempts).set({ quota_state: 'exempt', updated_at: nowSec() })
      .where(and(eq(deliveryAttempts.id, attempt.id), eq(deliveryAttempts.quota_state, 'none'))).run();
    current = await readAttempt(attempt);
  }
  if (current.quota_state === 'exempt') return { allowed: true, attempt: current };
  if (current.quota_state === 'released') return { allowed: false, reason: 'daily', attempt: current };
  if (current.quota_state === 'none') {
    await initializeAccounts(current);
    const configured = Number(await getConfig('daily_download_cap', '0')) || 0;
    const dailyLimit = configured > 0 ? configured : LIMITS.DEFAULT_DAILY_DOWNLOAD_LIMIT;
    const fileLimit = Number(await getConfig('file_daily_limit', LIMITS.DEFAULT_FILE_DAILY_LIMIT)) || 0;
    // The limit predicates and ownership transition execute in the same SQLite
    // statement. Different isolates cannot both reserve the last quota unit.
    await db.update(deliveryAttempts).set({ quota_state: 'reserved', updated_at: nowSec() }).where(and(
      eq(deliveryAttempts.id, current.id), eq(deliveryAttempts.quota_state, 'none'),
      dailyLimit > 0 ? sql`(${dailyUsage(current)}) < ${dailyLimit}` : sql`1`,
      fileLimit > 0 ? sql`(${linkUsage(current)}) < ${fileLimit}` : sql`1`,
    )).run();
    current = await readAttempt(current);
    if (current.quota_state === 'none') {
      const usage = await db.select({ daily: dailyUsage(current), link: linkUsage(current) }).from(deliveryQuotaAccounts)
        .where(eq(deliveryQuotaAccounts.id, dailyId(current))).get();
      return { allowed: false, reason: dailyLimit > 0 && Number(usage?.daily || 0) >= dailyLimit ? 'daily' : 'link', attempt: current };
    }
  }
  await projectDeliveryQuota(current);
  return { allowed: ['reserved', 'consumed', 'exempt'].includes(current.quota_state), attempt: current };
}

export async function projectDeliveryQuota(attempt) {
  const account = await db.select().from(deliveryQuotaAccounts).where(eq(deliveryQuotaAccounts.id, dailyId(attempt))).get();
  if (!account) return;
  await db.insert(userQuotas).values({ user_id: attempt.user_id }).onConflictDoNothing({ target: userQuotas.user_id }).run();
  // Late settlement of yesterday's attempt cannot replace today's security or
  // accounting state. Ban/Lockout fields are never touched by this projection.
  await db.update(userQuotas).set({ downloads_today: dailyUsage(attempt), last_download_date: attempt.period, last_request_at: nowSec() })
    .where(and(eq(userQuotas.user_id, attempt.user_id), sql`COALESCE(last_download_date, '') <= ${attempt.period}`)).run();
  let link = await db.select().from(deliveryQuotaAccounts).where(eq(deliveryQuotaAccounts.id, linkId(attempt))).get();
  if (!link) return;
  if (!link.audit_row_id) {
    const bundle = await db.select({ code: bundles.code }).from(bundles).where(eq(bundles.upload_session_id, attempt.bundle_id)).get();
    const code = bundle?.code || link.quota_code;
    await db.insert(userDownloads).values({ user_id: attempt.user_id, code, access_date: attempt.period, download_count: 0 })
      .onConflictDoNothing({ target: [userDownloads.user_id, userDownloads.code, userDownloads.access_date] }).run();
    const audit = await db.select({ id: userDownloads.id }).from(userDownloads).where(and(eq(userDownloads.user_id, attempt.user_id), eq(userDownloads.code, code), eq(userDownloads.access_date, attempt.period))).get();
    if (!audit) throw new Error('Delivery audit projection unavailable');
    await db.update(deliveryQuotaAccounts).set({ audit_row_id: audit.id, quota_code: code, updated_at: nowSec() })
      .where(and(eq(deliveryQuotaAccounts.id, link.id), eq(deliveryQuotaAccounts.audit_row_id, 0))).run();
    link = await db.select().from(deliveryQuotaAccounts).where(eq(deliveryQuotaAccounts.id, link.id)).get();
  }
  // The stable audit row id survives code rotation. Multiple accounts sharing a
  // reused code contribute to one aggregate, retaining the oldest legacy base.
  await db.update(userDownloads).set({ download_count: sql`
    COALESCE((SELECT MIN(base_count) FROM delivery_quota_accounts WHERE audit_row_id = ${link.audit_row_id} AND bundle_id != ''), 0)
    + (SELECT COUNT(*) FROM delivery_attempts AS usage
      WHERE usage.quota_state IN ('reserved', 'consumed') AND EXISTS (SELECT 1 FROM delivery_quota_accounts AS account
        WHERE account.audit_row_id = ${link.audit_row_id} AND account.bundle_id = usage.bundle_id
          AND account.user_id = usage.user_id AND account.period = usage.period))` })
    .where(eq(userDownloads.id, link.audit_row_id)).run();
}

export async function claimOneTime(attempt, bundle, isAdminTest = false) {
  if (isAdminTest || !bundle?.is_one_time) return { allowed: true, attempt: await readAttempt(attempt) };
  const currentBundle = await db.select().from(bundles).where(and(eq(bundles.upload_session_id, attempt.bundle_id), bundleAvailable())).get();
  if (!currentBundle || (currentBundle.consumed_by && Number(currentBundle.consumed_by) !== Number(attempt.user_id))) return { allowed: false, attempt: await readAttempt(attempt) };
  const now = nowSec();
  await db.insert(deliveryClaims).values({ bundle_id: attempt.bundle_id, attempt_id: attempt.id,
    user_id: attempt.user_id, state: 'released', created_at: now, updated_at: now,
  }).onConflictDoNothing({ target: deliveryClaims.bundle_id }).run();
  const available = sql`EXISTS (SELECT 1 FROM bundles WHERE upload_session_id = ${attempt.bundle_id}
    AND (consumed_by = 0 OR consumed_by = ${attempt.user_id})
    AND (expires_at = 0 OR expires_at > ${now}) AND ${bundleAvailable()})`;
  // Inserting an inert row provides the uniqueness arbiter. The actual claim
  // transition checks current Bundle state in the same SQLite statement.
  await db.update(deliveryClaims).set({ attempt_id: attempt.id, user_id: attempt.user_id,
    state: sql`CASE WHEN EXISTS (SELECT 1 FROM bundles WHERE upload_session_id = ${attempt.bundle_id}
      AND consumed_by = ${attempt.user_id}) THEN 'consumed' ELSE 'reserved' END`, created_at: now, updated_at: now,
  }).where(and(eq(deliveryClaims.bundle_id, attempt.bundle_id), eq(deliveryClaims.state, 'released'), available)).run();
  // The original product permits the consuming user to request again. Preserve
  // that only after the earlier attempt is terminal with no uncertain receipt;
  // an active reservation, including that user's own, is never stolen.
  await db.update(deliveryClaims).set({ attempt_id: attempt.id, updated_at: now }).where(and(
    eq(deliveryClaims.bundle_id, attempt.bundle_id), eq(deliveryClaims.state, 'consumed'), eq(deliveryClaims.user_id, attempt.user_id),
    sql`attempt_id != ${attempt.id}`, available,
    sql`EXISTS (SELECT 1 FROM delivery_attempts AS prior WHERE prior.id = delivery_claims.attempt_id AND prior.state IN ('completed', 'complete', 'failed', 'aborted'))`,
    sql`NOT EXISTS (SELECT 1 FROM delivery_items WHERE attempt_id = delivery_claims.attempt_id AND state IN ('dispatching', 'unknown'))`,
  )).run();
  const claim = await db.select().from(deliveryClaims).where(and(eq(deliveryClaims.bundle_id, attempt.bundle_id), available)).get();
  const allowed = claim?.attempt_id === attempt.id && claim.user_id === attempt.user_id && ['reserved', 'consumed'].includes(claim.state);
  if (allowed) await db.update(deliveryAttempts).set({ one_time_state: claim.state === 'consumed' ? 'consumed' : 'claimed', updated_at: nowSec() })
    .where(eq(deliveryAttempts.id, attempt.id)).run();
  return { allowed, attempt: await readAttempt(attempt) };
}

export async function settleDeliveryAttempt(attempt, bundle, { terminal = false, owner = null } = {}) {
  // Canonical per-item evidence decides settlement; caller/page counters cannot
  // erase a receipt or turn an ambiguous dispatch into a definitive failure.
  const receipts = await db.select().from(deliveryItems).where(eq(deliveryItems.attempt_id, attempt.id)).all();
  const confirmed = receipts.some((r) => r.state === 'confirmed');
  const unknown = receipts.some((r) => r.state === 'unknown' || r.state === 'dispatching');
  if (confirmed) {
    await db.update(deliveryAttempts).set({ quota_state: 'consumed', updated_at: nowSec() })
      .where(and(eq(deliveryAttempts.id, attempt.id), eq(deliveryAttempts.quota_state, 'reserved'))).run();
    await db.update(deliveryClaims).set({ state: 'consumed', updated_at: nowSec() }).where(and(
      eq(deliveryClaims.bundle_id, attempt.bundle_id), eq(deliveryClaims.attempt_id, attempt.id), eq(deliveryClaims.state, 'reserved'))).run();
    // Finalization is recoverable if a crash occurs between the claim proof and
    // the legacy Bundle projection. No confirmed consumption is ever released.
    const claim = await db.select().from(deliveryClaims).where(and(eq(deliveryClaims.bundle_id, attempt.bundle_id), eq(deliveryClaims.attempt_id, attempt.id), eq(deliveryClaims.state, 'consumed'))).get();
    if (claim) {
      const expiry = Number(claim.created_at) + 900;
      await db.update(bundles).set({ consumed_by: attempt.user_id,
        expires_at: sql`CASE WHEN expires_at > 0 AND expires_at < ${expiry} THEN expires_at ELSE ${expiry} END`,
      }).where(and(eq(bundles.upload_session_id, attempt.bundle_id), bundleAvailable(),
        sql`(consumed_by = 0 OR consumed_by = ${attempt.user_id})`,
        sql`EXISTS (SELECT 1 FROM delivery_claims WHERE bundle_id = ${attempt.bundle_id} AND attempt_id = ${attempt.id} AND state = 'consumed')`,
      )).run();
      await db.update(deliveryAttempts).set({ one_time_state: 'consumed', updated_at: nowSec() }).where(eq(deliveryAttempts.id, attempt.id)).run();
    }
  } else if (terminal && !unknown) {
    // A stale invocation cannot refund a newer worker between reservation and
    // dispatch. Recovery without an owner may release only an expired lease.
    const now = nowSec();
    const leaseFence = owner ? sql`lease_owner = ${owner} AND lease_until > ${now}` : sql`lease_until <= ${now}`;
    await db.update(deliveryAttempts).set({ quota_state: 'released', updated_at: nowSec() }).where(and(
      eq(deliveryAttempts.id, attempt.id), eq(deliveryAttempts.quota_state, 'reserved'),
      leaseFence,
      sql`NOT EXISTS (SELECT 1 FROM delivery_items WHERE attempt_id = ${attempt.id} AND state IN ('confirmed', 'dispatching', 'unknown'))`,
    )).run();
    await db.update(deliveryClaims).set({ state: 'released', updated_at: nowSec() }).where(and(
      eq(deliveryClaims.bundle_id, attempt.bundle_id), eq(deliveryClaims.attempt_id, attempt.id), eq(deliveryClaims.state, 'reserved'),
      sql`EXISTS (SELECT 1 FROM delivery_attempts WHERE id = ${attempt.id} AND ${leaseFence})`,
      sql`NOT EXISTS (SELECT 1 FROM delivery_items WHERE attempt_id = ${attempt.id} AND state IN ('confirmed', 'dispatching', 'unknown'))`,
    )).run();
    await db.update(deliveryAttempts).set({ one_time_state: 'released', updated_at: nowSec() }).where(and(
      eq(deliveryAttempts.id, attempt.id), eq(deliveryAttempts.one_time_state, 'claimed'),
      leaseFence,
      sql`EXISTS (SELECT 1 FROM delivery_claims WHERE bundle_id = ${attempt.bundle_id} AND attempt_id = ${attempt.id} AND state = 'released')`,
    )).run();
  }
  await projectDeliveryQuota(attempt);
  return await readAttempt(attempt);
}

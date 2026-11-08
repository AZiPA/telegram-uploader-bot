import { table, integer, text, boolean, json, index, uniqueIndex, sql } from 'sdk/db';

export const bundles = table('bundles', {
  code: text().primaryKey(),
  title: text(),
  items: json().notNull().default([]),
  created_by: integer().notNull(),
  protect_content: boolean().notNull().default(false),
  created_at: integer().notNull().default(sql`(unixepoch())`),
  owner_locked: boolean().notNull().default(false),
  expires_at: integer().notNull().default(0),
  is_one_time: boolean().notNull().default(false),
  consumed_by: integer().notNull().default(0),
  passcode_hash: text(),
  post_channel_id: text(),
  post_message_id: integer().notNull().default(0),
  rotate_interval_sec: integer().notNull().default(0),
  last_rotated_at: integer().notNull().default(0),
  upload_session_id: text().unique(),
  removed_item_ids: json().notNull().default([]),
}, (t) => ({
  idxBundlesSearch: index('idx_bundles_search').on(t.title),
  idxBundlesRotation: index('idx_bundles_rotation').on(t.last_rotated_at),
  idxBundlesCreator: index('idx_bundles_creator').on(t.created_by),
  idxBundlesExpiring: index('idx_bundles_expiring').on(t.expires_at).where(sql`expires_at > 0`),
}));

export const adminSessions = table('admin_sessions', {
  admin_id: integer().primaryKey(),
  code: text().notNull(),
  mode: text(),
  items: json().notNull().default([]),
  updated_at: integer().notNull().default(sql`(unixepoch())`),
  session_id: text().notNull().default(''),
  generation: text().notNull().default(''),
  state: text().notNull().default('active'),
  revision: integer().notNull().default(0),
});

export const bundleVotes = table('bundle_votes', {
  id: integer().primaryKey({ autoIncrement: true }),
  code: text().notNull(),
  user_id: integer().notNull(),
  vote_type: text(),
  created_at: integer().notNull().default(sql`(unixepoch())`),
}, (t) => ({
  uidxBundleUserVote: uniqueIndex('uidx_bundle_user_vote').on(t.code, t.user_id),
}));

export const deletionQueue = table('deletion_queue', {
  id: integer().primaryKey({ autoIncrement: true }),
  chat_id: integer().notNull(),
  message_ids: text().notNull(),
  delete_at: integer().notNull(),
  delivery_receipt_id: text().unique(),
}, (t) => ({
  idxDeletionDeleteAt: index('idx_deletion_delete_at').on(t.delete_at),
}));

export const admins = table('admins', {
  user_id: integer().primaryKey(),
  added_by: integer().notNull(),
  role: text().notNull().default('admin'),
  created_at: integer().notNull().default(sql`(unixepoch())`),
});

export const vips = table('vips', {
  user_id: integer().primaryKey(),
  added_by: integer().notNull(),
  expires_at: integer().notNull().default(0),
  created_at: integer().notNull().default(sql`(unixepoch())`),
}, (t) => ({
  idxVipsExpiring: index('idx_vips_expiring').on(t.expires_at).where(sql`expires_at > 0`),
}));

export const userQuotas = table('user_quotas', {
  user_id: integer().primaryKey(),
  downloads_today: integer().default(0),
  last_download_date: text().default(''),
  last_request_at: integer().notNull().default(0),
  strikes: integer().default(0),
  banned_until: integer().default(0),
});

export const userDownloads = table('user_downloads', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull(),
  code: text().notNull(),
  access_date: text().notNull(),
  download_count: integer().default(1),
}, (t) => ({
  idxUserDownloadsDateCode: index('idx_user_downloads_date_code').on(t.access_date, t.code),
  idxUserDownloadsUserDate: index('idx_user_downloads_user_date').on(t.user_id, t.access_date),
  idxUserDownloadsCode: index('idx_user_downloads_code').on(t.code, t.download_count),
  idxUserDownloadsUnique: uniqueIndex('idx_user_downloads_unique').on(t.user_id, t.code, t.access_date),
}));

export const systemConfig = table('system_config', {
  key: text().primaryKey(),
  value: text().notNull(),
}).withoutRowid();

export const forceChannels = table('force_channels', {
  channel_id: text().primaryKey(),
  channel_name: text().notNull(),
  button_text: text().default(''),
  invite_link: text().notNull(),
  target_limit: integer().default(0),
  is_active: boolean().default(true),
  created_at: integer().notNull().default(sql`(unixepoch())`),
});

export const userSessions = table('user_sessions', {
  user_id: integer('user_id').primaryKey(),
  mode: text('mode').notNull(),
  code: text('code'),
  attempts: integer('attempts').default(0),
  updated_at: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (t) => ({
  idxUserSessionsUpdated: index('idx_user_sessions_updated').on(t.updated_at),
}));

export const botConfig = table('bot_config', {
  id: text('id').primaryKey().default('active'),
  overrides: text('overrides', { mode: 'json' }).notNull(),
  updated_at: integer('updated_at').notNull(),
});

// Durable upload state is separate from the replaceable admin prompt pointer.
export const uploadSessions = table('upload_sessions', {
  id: text().primaryKey(),
  admin_id: integer().notNull(),
  generation: text().notNull(),
  mode: text().notNull(),
  bundle_code: text().notNull().default(''),
  bundle_id: text().notNull().default(''),
  state: text().notNull().default('open'),
  items: json().notNull().default([]),
  revision: integer().notNull().default(0),
  result_code: text().notNull().default(''),
  protect_content: boolean().notNull().default(false),
  expires_at: integer().notNull().default(0),
  created_at: integer().notNull(),
  updated_at: integer().notNull().default(0),
  start_update_id: integer(),
  start_pointer: json(),
}, (t) => ({
  idxUploadSessionsAdmin: index('idx_upload_sessions_admin').on(t.admin_id),
  uidxUploadSessionsStartUpdate: uniqueIndex('uidx_upload_sessions_start_update').on(t.admin_id, t.start_update_id),
}));

export const uploadItems = table('upload_items', {
  id: text().primaryKey(),
  session_id: text().notNull(),
  admin_id: integer().notNull(),
  source_chat_id: integer().notNull(),
  source_message_id: integer().notNull(),
  update_id: integer(),
  kind: text().notNull().default('item'),
  state: text().notNull().default('pending'),
  item: json().notNull(),
  mirror_state: text().notNull().default('none'),
  mirror_snapshot: text().notNull().default(''),
  storage_channel_id: text().notNull().default(''),
  storage_message_id: integer().notNull().default(0),
}, (t) => ({
  uidxUploadItemsSource: uniqueIndex('uidx_upload_items_source').on(t.session_id, t.source_chat_id, t.source_message_id),
  uidxUploadItemsUpdate: uniqueIndex('uidx_upload_items_update').on(t.admin_id, t.update_id),
}));

export const adminTestContinuations = table('admin_test_continuations', {
  operation_id: text().primaryKey(),
  user_id: integer().notNull(),
  chat_id: integer().notNull(),
  bundle_code: text().notNull(),
  bundle_id: text().notNull().default(''),
  expires_at: integer().notNull(),
});

// Phase 2 activation requires separately reviewed additive migrations.
export const deliveryOperations = table('delivery_operations', {
  id: text().primaryKey(),
  request_key: text().notNull().unique(),
  user_id: integer().notNull(),
  chat_id: integer().notNull(),
  bundle_id: text().notNull(),
  bundle_code: text().notNull(),
  items: json().notNull(),
  attempt_id: text().notNull().unique(),
  admin_test_id: text().notNull().default(''),
  state: text().notNull().default('active'),
  expires_at: integer().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (t) => ({
  idxDeliveryOperationsBundle: index('idx_delivery_operations_bundle').on(t.bundle_id, t.state),
}));

export const deliveryAttempts = table('delivery_attempts', {
  id: text().primaryKey(),
  operation_id: text().notNull().unique(),
  user_id: integer().notNull(),
  chat_id: integer().notNull(),
  bundle_id: text().notNull(),
  quota_code: text().notNull(),
  period: text().notNull(),
  quota_state: text().notNull().default('none'),
  one_time_state: text().notNull().default('none'),
  state: text().notNull().default('active'),
  lease_owner: text().notNull().default(''),
  lease_until: integer().notNull().default(0),
  retry_at: integer().notNull().default(0),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (t) => ({
  idxDeliveryAttemptsQuota: index('idx_delivery_attempts_quota').on(t.user_id, t.period, t.quota_state),
  idxDeliveryAttemptsBundle: index('idx_delivery_attempts_bundle').on(t.bundle_id, t.state),
}));

export const deliveryItems = table('delivery_items', {
  id: text().primaryKey(),
  attempt_id: text().notNull(),
  item_id: text().notNull(),
  state: text().notNull().default('pending'),
  message_id: integer().notNull().default(0),
  stage: text().notNull().default(''),
  method: text().notNull().default(''),
  retry_at: integer().notNull().default(0),
  delete_at: integer().notNull().default(0),
  queue_state: text().notNull().default('none'),
  updated_at: integer().notNull(),
}, (t) => ({
  uidxDeliveryItemsAttemptItem: uniqueIndex('uidx_delivery_items_attempt_item').on(t.attempt_id, t.item_id),
}));

// One row arbitrates the global One-Time Bundle reservation. A consumed row
// remains the durable proof even after the Bundle has been physically deleted.
export const deliveryClaims = table('delivery_claims', {
  bundle_id: text().primaryKey(),
  attempt_id: text().notNull(),
  user_id: integer().notNull(),
  state: text().notNull().default('reserved'),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

// Frozen pre-ledger usage plus attempt-owned reservations is the quota source
// of truth. Legacy counters and download history are recoverable projections.
export const deliveryQuotaAccounts = table('delivery_quota_accounts', {
  id: text().primaryKey(),
  user_id: integer().notNull(),
  period: text().notNull(),
  bundle_id: text().notNull().default(''),
  quota_code: text().notNull().default(''),
  base_count: integer().notNull().default(0),
  audit_row_id: integer().notNull().default(0),
  updated_at: integer().notNull(),
}, (t) => ({
  idxDeliveryQuotaPeriod: index('idx_delivery_quota_period').on(t.user_id, t.period, t.bundle_id),
  idxDeliveryQuotaAudit: index('idx_delivery_quota_audit').on(t.audit_row_id),
}));

// Retained terminal keys prevent a replay from becoming a new user action.
export const routerUpdates = table('router_updates', {
  update_id: integer().primaryKey(),
  state: text().notNull().default('in_progress'),
  token: text().notNull(),
  lease_until: integer().notNull(),
  dispatched: integer().notNull().default(0),
  content_dispatched: integer().notNull().default(0),
  operation_kind: text().notNull().default(''),
  operation_id: text().notNull().default(''),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (t) => ({
  idxRouterUpdatesState: index('idx_router_updates_state').on(t.state, t.lease_until),
}));

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
userSessions.userId = userSessions.user_id;
userSessions.updatedAt = userSessions.updated_at;

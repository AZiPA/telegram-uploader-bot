import { table, integer, text } from 'sdk/db';

export const sqliteTable = table;

export const botConfig = sqliteTable('bot_config', {
  id: text('id').primaryKey().default('active'),
  overrides: text('overrides', { mode: 'json' }).notNull(),
  updated_at: integer('updated_at').notNull(),
});

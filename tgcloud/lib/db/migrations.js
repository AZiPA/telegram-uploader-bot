export const CREATE_BOT_CONFIG_TABLE = `
CREATE TABLE IF NOT EXISTS bot_config (
  id TEXT PRIMARY KEY DEFAULT 'active',
  overrides TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`.trim();

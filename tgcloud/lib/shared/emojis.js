import { db as defaultDb, getConfig } from '../helpers.js';

export const EMOJI_REGISTRY = {
  bundle:   ['📦', '6226477633052350835'],
  folder:   ['📁', '6237770966089340718'],
  lock:     ['🔒', '6237771472895481325'],
  unlocked: ['🔓', '6237744062414199130'],
  vip:      ['⭐️', '6237588052022139733'],
  success:  ['✅', '6237717571055916065'],
  danger:   ['❌', '6237772568112142557'],
  stats:    ['📊', '6239998181510223734'],
  settings: ['⚙️', '6143411531028632701'],
  search:   ['🔍', '6269244589513642539'],
  download: ['📥', '6226477633052350835'],
  warning:  ['⚠️', '6237772568112142557'],
};

export async function isPremiumEmojiEnabled(db = defaultDb) {
  try {
    const targetDb = db || defaultDb;
    if (targetDb) {
      if (typeof targetDb.query?.systemConfig?.findFirst === 'function') {
        const row = await targetDb.query.systemConfig.findFirst({
          where: (tbl, { eq }) => eq(tbl.key, 'premium_emojis_enabled'),
        });
        return row?.value === 'true';
      }
      if (typeof targetDb.query?.system_config?.findFirst === 'function') {
        const row = await targetDb.query.system_config.findFirst({
          where: (tbl, { eq }) => eq(tbl.key, 'premium_emojis_enabled'),
        });
        return row?.value === 'true';
      }
      if (typeof targetDb.systemConfig?.findFirst === 'function') {
        const row = await targetDb.systemConfig.findFirst({
          where: (tbl, { eq }) => eq(tbl.key, 'premium_emojis_enabled'),
        });
        return row?.value === 'true';
      }
      if (typeof targetDb.system_config?.findFirst === 'function') {
        const row = await targetDb.system_config.findFirst({
          where: (tbl, { eq }) => eq(tbl.key, 'premium_emojis_enabled'),
        });
        return row?.value === 'true';
      }
      if (typeof targetDb.prepare === 'function') {
        try {
          const stmt = targetDb.prepare("SELECT value FROM system_config WHERE key = 'premium_emojis_enabled'");
          const row = typeof stmt.first === 'function' ? await stmt.first() : (typeof stmt.get === 'function' ? await stmt.get() : await stmt.all());
          const val = Array.isArray(row) ? row[0]?.value : row?.value;
          if (val !== undefined) return val === 'true';
        } catch (_) {}
      }
      if (typeof targetDb.query === 'function') {
        try {
          const res = await targetDb.query("SELECT value FROM system_config WHERE key = 'premium_emojis_enabled'");
          const row = Array.isArray(res) ? res[0] : (res?.rows?.[0] || res?.[0]);
          if (row?.value !== undefined) return row.value === 'true';
        } catch (_) {}
      }
    }
    if (typeof getConfig === 'function') {
      const val = await getConfig('premium_emojis_enabled', 'false');
      return val === 'true';
    }
  } catch (_) {
    return false;
  }
  return false;
}

export function e(name, isPremium = false) {
  const entry = EMOJI_REGISTRY[name];
  if (!entry) return '';
  const [fallbackUnicode, customId] = entry;
  if (!isPremium || !customId) {
    return fallbackUnicode;
  }
  return `<tg-emoji emoji-id="${customId}">${fallbackUnicode}</tg-emoji>`;
}

export function btnIcon(name, isPremium = false) {
  if (!isPremium) return undefined;
  const entry = EMOJI_REGISTRY[name];
  if (!entry) return undefined;
  const [, customId] = entry;
  return customId ? String(customId) : undefined;
}

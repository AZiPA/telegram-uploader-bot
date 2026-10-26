import { db } from 'sdk';
import { eq } from 'sdk/db';
import { systemConfig } from '../../schema.js';
import { tgApi } from './telegram.js';

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function parseItems(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export const configCache = new Map();

export async function getConfig(key, fallback = null) {
  const now = Math.floor(Date.now() / 1000);
  const cached = configCache.get(key);
  let raw;
  if (cached && cached.exp > now) {
    raw = cached.raw !== undefined ? cached.raw : cached.value;
  } else {
    const row = await db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.key, key)).get();
    raw = row ? row.value : null;
    configCache.set(key, { raw, exp: now + 15 });
  }
  return raw !== null && raw !== undefined ? raw : fallback;
}

export async function setConfig(key, value) {
  const strVal = String(value);
  await db.insert(systemConfig)
    .values({ key, value: strVal })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: strVal },
    })
    .run();
  configCache.set(key, { raw: strVal, exp: Math.floor(Date.now() / 1000) + 15 });
  return strVal;
}

let cachedBotUsername = null;

export async function getBotUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const me = await tgApi.getMe({});
    if (me?.username) {
      cachedBotUsername = me.username.replace(/^@/, '');
      return cachedBotUsername;
    }
  } catch (err) {
    console.error('Failed to get bot username via api.getMe():', err);
  }
  return '';
}

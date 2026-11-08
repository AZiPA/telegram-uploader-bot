import { db } from 'sdk';
import { eq, and, or } from 'sdk/db';
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

const STORAGE_SNAPSHOT_KEY = 'storage_channel_snapshot';
const STORAGE_CAS_ATTEMPTS = 4;
const cleanStorageChannel = (value) => {
  const channel = String(value || '').trim();
  return ['off', '0', 'clear', 'disable', 'none'].includes(channel.toLowerCase()) ? '' : channel;
};

function decodeStorageSnapshot(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value.channel_id !== 'string' || typeof value.enabled !== 'boolean'
    || typeof value.generation !== 'string' || !value.generation) throw new Error('STORAGE_CONFIG_INVALID');
  return Object.freeze({ channel_id: cleanStorageChannel(value.channel_id), enabled: value.enabled,
    generation: value.generation, raw });
}

function storageValue(channel, enabled) {
  return JSON.stringify({ channel_id: cleanStorageChannel(channel), enabled, generation: crypto.randomUUID() });
}

// The complete upload destination is one row and is never assembled from
// independently cached keys. Legacy keys are read together only at bootstrap.
export async function getStorageSnapshot() {
  let row = await db.select().from(systemConfig).where(eq(systemConfig.key, STORAGE_SNAPSHOT_KEY)).get();
  if (!row) {
    const legacy = await db.select().from(systemConfig).where(or(
      eq(systemConfig.key, 'storage_channel_id'), eq(systemConfig.key, 'storage_channel_active'),
    )).all();
    const values = new Map(legacy.map((entry) => [entry.key, entry.value]));
    const raw = storageValue(values.get('storage_channel_id'), values.get('storage_channel_active') === 'true');
    await db.insert(systemConfig).values({ key: STORAGE_SNAPSHOT_KEY, value: raw })
      .onConflictDoNothing({ target: systemConfig.key }).run();
    row = await db.select().from(systemConfig).where(eq(systemConfig.key, STORAGE_SNAPSHOT_KEY)).get();
  }
  if (!row) throw new Error('STORAGE_CONFIG_UNAVAILABLE');
  return decodeStorageSnapshot(row.value);
}

async function mutateStorageSnapshot(change) {
  for (let attempt = 0; attempt < STORAGE_CAS_ATTEMPTS; attempt++) {
    const current = await getStorageSnapshot();
    const next = change(current);
    if (typeof next.enabled !== 'boolean') throw new Error('STORAGE_CONFIG_INVALID');
    const raw = storageValue(next.channel_id, next.enabled);
    const changed = await db.update(systemConfig).set({ value: raw }).where(and(
      eq(systemConfig.key, STORAGE_SNAPSHOT_KEY), eq(systemConfig.value, current.raw),
    )).run();
    if (changed.rowsAffected === 1) {
      configCache.delete('storage_channel_id');
      configCache.delete('storage_channel_active');
      return decodeStorageSnapshot(raw);
    }
  }
  throw new Error('STORAGE_CONFIG_CONTENTION');
}

export async function setStorageSnapshot({ channel_id, enabled }) {
  return mutateStorageSnapshot(() => ({ channel_id, enabled }));
}

// An old request must not disable a replacement configuration, even if the
// owner has changed away from a channel and then selected that channel again.
export async function disableStorageSnapshot(snapshot) {
  if (!snapshot?.raw || !snapshot.enabled) return false;
  const raw = storageValue(snapshot.channel_id, false);
  const changed = await db.update(systemConfig).set({ value: raw }).where(and(
    eq(systemConfig.key, STORAGE_SNAPSHOT_KEY), eq(systemConfig.value, snapshot.raw),
  )).run();
  return changed.rowsAffected === 1;
}

export async function getConfig(key, fallback = null) {
  if (key === 'storage_channel_id' || key === 'storage_channel_active') {
    const snapshot = await getStorageSnapshot();
    return key === 'storage_channel_id' ? (snapshot.channel_id || fallback) : String(snapshot.enabled);
  }
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
  if (key === 'storage_channel_id' || key === 'storage_channel_active') {
    await mutateStorageSnapshot((snapshot) => key === 'storage_channel_id'
      ? { channel_id: value, enabled: snapshot.enabled }
      : { channel_id: snapshot.channel_id, enabled: String(value) === 'true' });
    return String(value);
  }
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

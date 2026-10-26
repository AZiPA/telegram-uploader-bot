import configDefaults from '../../config.js';
import { db } from 'sdk';
import { eq } from 'sdk/db';
import { botConfig } from '../db/schema.js';

let cachedConfig = null;

export function invalidateConfigCache() {
  cachedConfig = null;
}

const PROHIBITED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BLACKLISTED_KEYS = new Set([
  'owner_id',
  'admins',
  'vips',
  'tokens',
  'pending_owner_transfer',
  '__proto__',
  'constructor',
  'prototype',
]);

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function safeClone(val) {
  if (Array.isArray(val)) {
    return val.map(safeClone);
  }
  if (isPlainObject(val)) {
    const out = {};
    for (const key of Object.keys(val)) {
      if (!PROHIBITED_KEYS.has(key)) {
        out[key] = safeClone(val[key]);
      }
    }
    return out;
  }
  return val;
}

export function safeDeepMerge(target, source) {
  const result = safeClone(target);
  if (!isPlainObject(source)) {
    return result;
  }
  for (const key of Object.keys(source)) {
    if (PROHIBITED_KEYS.has(key)) continue;
    const srcVal = source[key];
    const tgtVal = result[key];
    if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = safeDeepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      result[key] = safeClone(srcVal);
    }
  }
  return result;
}

function sanitizeBlacklistedKeys(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeBlacklistedKeys);
  }
  if (isPlainObject(obj)) {
    const out = {};
    for (const key of Object.keys(obj)) {
      if (!BLACKLISTED_KEYS.has(key)) {
        out[key] = sanitizeBlacklistedKeys(obj[key]);
      }
    }
    return out;
  }
  return obj;
}

function areArraysEqual(arrA, arrB) {
  if (!Array.isArray(arrA) || !Array.isArray(arrB)) return false;
  if (arrA.length !== arrB.length) return false;
  return arrA.every((item, i) => item === arrB[i]);
}

function computeSparseDiff(current, base) {
  if (current === base) return undefined;
  if (current === null || base === null || typeof current !== 'object' || typeof base !== 'object') {
    return current;
  }
  if (Array.isArray(current) && Array.isArray(base)) {
    return areArraysEqual(current, base) ? undefined : current;
  }
  if (Array.isArray(current) || Array.isArray(base)) {
    return current;
  }
  const diff = {};
  for (const key of Object.keys(current)) {
    if (BLACKLISTED_KEYS.has(key)) continue;
    if (!(key in base)) {
      diff[key] = current[key];
    } else {
      const nestedDiff = computeSparseDiff(current[key], base[key]);
      if (nestedDiff !== undefined) {
        diff[key] = nestedDiff;
      }
    }
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
}

export async function getActiveConfig(database = db) {
  if (cachedConfig) {
    return cachedConfig;
  }
  const dbInstance = database || db;
  const row = await dbInstance.select().from(botConfig).where(eq(botConfig.id, 'active')).get();
  let overrides = {};
  if (row?.overrides) {
    if (typeof row.overrides === 'string') {
      try {
        overrides = JSON.parse(row.overrides);
      } catch {
        overrides = {};
      }
    } else if (typeof row.overrides === 'object') {
      overrides = row.overrides;
    }
  }
  cachedConfig = safeDeepMerge(configDefaults, overrides);
  return cachedConfig;
}

export async function exportConfigJson(database = db) {
  const active = await getActiveConfig(database);
  return JSON.stringify(active, null, 2);
}

export async function importConfigJson(dbOrJson, rawJsonString) {
  let database = db;
  let rawStr = rawJsonString;
  if (typeof dbOrJson === 'string') {
    rawStr = dbOrJson;
  } else if (dbOrJson) {
    database = dbOrJson;
  }

  if (typeof rawStr !== 'string') {
    throw new Error('CONFIG_ERR_INVALID_JSON');
  }

  const sanitizedStr = rawStr.replace(/[“”«»]/g, '"');
  let parsed;
  try {
    parsed = JSON.parse(sanitizedStr);
  } catch {
    throw new Error('CONFIG_ERR_INVALID_JSON');
  }

  if (!isPlainObject(parsed)) {
    throw new Error('CONFIG_ERR_INVALID_JSON');
  }

  // Strip blacklisted keys
  const cleaned = sanitizeBlacklistedKeys(parsed);

  // Validate locales.supported
  if (cleaned.locales && 'supported' in cleaned.locales) {
    if (!areArraysEqual(cleaned.locales.supported, configDefaults.locales.supported)) {
      throw new Error('CONFIG_ERR_IMMUTABLE_LOCALES');
    }
  }

  // Validate locales.default
  if (cleaned.locales && 'default' in cleaned.locales) {
    if (!configDefaults.locales.supported.includes(cleaned.locales.default)) {
      throw new Error('CONFIG_ERR_INVALID_LOCALE');
    }
  }

  // Compute sparse diff against configDefaults
  const diffObject = computeSparseDiff(cleaned, configDefaults) || {};
  const changedCount = Object.keys(diffObject).length;
  const isResetToDefault = changedCount === 0;

  const dbInstance = database || db;
  if (isResetToDefault) {
    await dbInstance.delete(botConfig).where(eq(botConfig.id, 'active')).run();
  } else {
    const now = Math.floor(Date.now() / 1000);
    await dbInstance.insert(botConfig)
      .values({
        id: 'active',
        overrides: diffObject,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: botConfig.id,
        set: {
          overrides: diffObject,
          updated_at: now,
        },
      })
      .run();
  }

  invalidateConfigCache();
  return { changedCount, isResetToDefault };
}

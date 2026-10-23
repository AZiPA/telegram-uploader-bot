export async function sha256Hex(message) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Ultra-fast, zero-bias 8-char Base62 generator (V8 JIT-optimized).
 * - Single-cycle bitwise AND (& 63) instead of division
 * - 12-byte flat buffer for single-pass completion
 * - Zero GC overhead
 */
export function generateBase62Code(length = 8) {
  const buffer = new Uint8Array(12);
  crypto.getRandomValues(buffer);

  let result = '';
  let cursor = 0;

  while (result.length < length) {
    if (cursor >= 12) {
      crypto.getRandomValues(buffer);
      cursor = 0;
    }
    const val = buffer[cursor++] & 63;
    if (val < 62) {
      result += BASE62_CHARS[val];
    }
  }

  return result;
}

/**
 * Native 36-character RFC 4122 UUID v4 for protected bundles.
 */
export function generateProtectedCode() {
  return crypto.randomUUID();
}

/**
 * Unified bundle code generator based on protection status.
 */
export function generateBundleCode(isProtected = false) {
  return isProtected ? generateProtectedCode() : generateBase62Code(8);
}

/**
 * Validates whether an incoming start payload is either an 8-char Base62 or 36-char UUID code.
 */
export const BUNDLE_CODE_REGEX = /^([0-9a-zA-Z]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function isValidBundleCode(code) {
  return typeof code === 'string' && BUNDLE_CODE_REGEX.test(code);
}

/**
 * Legacy compatibility alias for generateCode.
 */
export function generateCode(arg = 8) {
  if (typeof arg === 'boolean') {
    return generateBundleCode(arg);
  }
  return generateBase62Code(arg);
}

export async function hashBundlePin(bundle, pin) {
  const salt = String(bundle?.created_at || bundle?.created_by || bundle?.creator_id || 'salt');
  const hash = await sha256Hex(`${salt}:${pin}`);
  return `v2:${hash}`;
}

export async function verifyBundlePin(bundle, pin) {
  if (!bundle || !bundle.passcode_hash || !pin) return false;
  if (String(bundle.passcode_hash).startsWith('v2:')) {
    const expected = await hashBundlePin(bundle, pin);
    return bundle.passcode_hash === expected;
  }
  const legacyHash = await sha256Hex(`${bundle.code}:${pin}`);
  return bundle.passcode_hash === legacyHash;
}

// ============================================================================
// # SECTION: DATABASE & SCHEMA DSL RE-EXPORTS
// Drizzle-like Telegram Serverless ORM primitives and 11 storage tables
// Used by: all operational domain modules across tgcloud/lib/**
// ============================================================================
export { db, api } from 'sdk';
export {
  eq, ne, gt, gte, lt, lte, like, notLike, isNull, isNotNull,
  and, or, not, inArray, notInArray, count, sum, desc, asc, sql
} from 'sdk/db';
export {
  admins, systemConfig, bundles, adminSessions, userSessions,
  vips, userQuotas, userDownloads, forceChannels, bundleVotes, deletionQueue,
  botConfig
} from '../schema.js';

// ============================================================================
// # SECTION: SHARED CONSTANTS
// Central action strings and system limits
// Used by: command guards, routers, panels, bundles, filestore
// ============================================================================
export { LIMITS, ACTIONS, DEFAULT_LANGUAGE } from './shared/constants.js';

// ============================================================================
// # SECTION: SHARED FORMATTERS & ENCODING
// HTML escaping, text formatting, and date/limit humanizers
// Used by: all UI generators, panels, alerts, and views
// ============================================================================
import { escapeHtml } from './shared/formatters.js';
export {
  escapeHtml, truncateText, formatAutoDelete, formatBundleTtl, formatDailyCap,
  splitStandardMessage, splitRichMessage, splitHtmlPreservingTags
} from './shared/formatters.js';

export function safeSliceEscape(str = '', max = 64) {
  return escapeHtml(String(str || '').slice(0, max));
}

// ============================================================================
// # SECTION: SHARED CRYPTO & TOKENS
// Web Crypto hashing, random tokens, and PIN verification
// Used by: bundle links, passcode authentication, and security checks
// ============================================================================
export {
  sha256Hex, generateCode, generateBase62Code, generateProtectedCode,
  generateBundleCode, BUNDLE_CODE_REGEX, isValidBundleCode
} from './shared/crypto.js';

// ============================================================================
// # SECTION: TELEGRAM API WRAPPERS
// Strongly typed tgApi calls and message sending/editing helpers
// Used by: all command handlers, wizards, panels, and delivery flows
// ============================================================================
export {
  tgApi, defaultTgApi, buildForceReply, sendMsg, sendSplitMsg, editMsg, editMarkup, answerCq,
  stripCustomEmojiTags, isCustomEmojiError
} from './shared/telegram.js';

// ============================================================================
// # SECTION: SYSTEM CONFIGURATION & ENVIRONMENT
// Dynamic configuration repository, bot profile info, and admin alerts
// Used by: middlewares, router, settings panels, maintenance passes
// ============================================================================
export const strikeMap = new Map();
const originalStrikeMapSet = strikeMap.set.bind(strikeMap);
strikeMap.set = function (key, timestamp) {
  if (strikeMap.size > 2000) {
    const cutoff = Date.now() - 60000;
    for (const [k, ts] of strikeMap.entries()) {
      if (ts < cutoff) strikeMap.delete(k);
    }
  }
  return originalStrikeMapSet(key, timestamp);
};

export {
  nowSec, parseItems, configCache, getConfig, setConfig, getBotUsername
} from './shared/config.js';
export {
  getActiveConfig, exportConfigJson, importConfigJson, invalidateConfigCache
} from './shared/config_service.js';
export { sendLogAlert } from './services/log_channel.js';

// ============================================================================
// # SECTION: ROLE AUTHENTICATION & ACCESS CONTROL
// Permission hierarchy, owner claiming, and role resolution
// Used by: command guard, admin panel, bundle management, force-join
// ============================================================================
export {
  ROLE_LEVELS, getRoleLevel, getEffectiveOwnerId, claimOwnerAtomically, getUserRole
} from './middlewares/auth.js';

// ============================================================================
// # SECTION: BOT OWNERSHIP LIFECYCLE
// Zero-state bootstrap and two-step ownership transfer
// Used by: handlers, router, and admin operational flow
// ============================================================================
export {
  handleZeroStateClaim, initiateOwnershipTransfer, confirmOwnershipTransfer,
  cancelOwnershipTransfer, handleOwnerCallback
} from './admin/ownership.js';

// ============================================================================
// # SECTION: SESSIONS & BUNDLE ACCESS
// Admin prompt tracking and bundle ownership check
// Used by: filestore, delivery, bundles, and admin controllers
// ============================================================================
export {
  clearAdminSession, clearUserSession, setAdminPrompt, getAdminSession, getBundle, canManageBundle
} from './shared/sessions.js';

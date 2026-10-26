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

const UNICODE_TO_EMOJI_NAME = {
  '📦': 'bundle',
  '📁': 'folder',
  '🔒': 'lock',
  '🔓': 'unlocked',
  '⭐️': 'vip',
  '✅': 'success',
  '❌': 'danger',
  '📊': 'stats',
  '⚙️': 'settings',
  '🔍': 'search',
  '📥': 'download',
  '⚠️': 'warning',
};

const EMOJI_TOKEN_REGEX = /(<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>)|(📦|📁|🔒|🔓|⭐️|✅|❌|📊|⚙️|🔍|📥|⚠️)/gu;

export function applyEmojis(text, isPremium = false) {
  if (!text || !isPremium) return text;
  return String(text).replace(EMOJI_TOKEN_REGEX, (match, existingTag, unicodeEmoji) => {
    if (existingTag) return existingTag;
    const name = UNICODE_TO_EMOJI_NAME[unicodeEmoji];
    return name ? e(name, true) : match;
  });
}

export async function isPremiumEmojiEnabled(db = defaultDb) {
  try {
    const val = await getConfig('premium_emojis_enabled', 'false');
    return val === 'true';
  } catch (_) {
    return false;
  }
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

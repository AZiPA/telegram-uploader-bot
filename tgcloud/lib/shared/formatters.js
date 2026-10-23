import { t } from '../locales/index.js';

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const TRACKED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler'
]);

function adjustCutPoint(text, cut) {
  if (cut <= 0) return 0;
  if (cut >= text.length) return text.length;

  // 1. Tag boundary check: don't cut inside <...>
  const lastLt = text.lastIndexOf('<', cut - 1);
  if (lastLt !== -1) {
    const lastGt = text.lastIndexOf('>', cut - 1);
    if (lastLt > lastGt) {
      const nextGt = text.indexOf('>', lastLt);
      if (nextGt === -1 || nextGt >= cut - 1) {
        cut = lastLt;
      }
    }
  }

  // 2. Entity boundary check: don't cut inside &...;
  const lastAmp = text.lastIndexOf('&', cut - 1);
  if (lastAmp !== -1) {
    const nextSemi = text.indexOf(';', lastAmp);
    if (nextSemi !== -1 && nextSemi >= cut) {
      const candidate = text.slice(lastAmp, nextSemi + 1);
      if (/^&[a-zA-Z0-9#]{1,31};$/.test(candidate)) {
        cut = lastAmp;
      }
    }
  }

  return Math.max(0, cut);
}

function getOpenTags(html) {
  const openTags = [];
  const tagRegex = /<\/?([a-zA-Z0-9-]+)(?:\s+[^>]*)?>/g;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    if (match[0].endsWith('/>')) continue;
    const isClosing = match[0].startsWith('</');
    const tagName = match[1].toLowerCase();
    if (!TRACKED_TAGS.has(tagName)) continue;
    if (isClosing) {
      const idx = openTags.lastIndexOf(tagName);
      if (idx !== -1) {
        openTags.splice(idx, 1);
      }
    } else {
      openTags.push(tagName);
    }
  }
  return openTags;
}

export function truncateText(text, max = 4096) {
  if (!text || text.length <= max) return text;

  let cut = Math.max(0, max - 3);
  cut = adjustCutPoint(text, cut);

  let openTags = getOpenTags(text.slice(0, cut));
  let closingTags = openTags.slice().reverse().map(tag => `</${tag}>`).join('');

  let prevCut = -1;
  while (cut > 0 && cut + 3 + closingTags.length > max && cut !== prevCut) {
    prevCut = cut;
    cut = Math.max(0, max - 3 - closingTags.length);
    cut = adjustCutPoint(text, cut);
    openTags = getOpenTags(text.slice(0, cut));
    closingTags = openTags.slice().reverse().map(tag => `</${tag}>`).join('');
  }

  return text.slice(0, cut) + '...' + closingTags;
}

export function formatAutoDelete(val, lang = 'en') {
  const sec = Number(val);
  if (!sec || sec <= 0) return t(lang, 'settings_val_off');
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export function formatBundleTtl(val, lang = 'en') {
  const hours = Number(val);
  if (!hours || hours <= 0) return t(lang, 'settings_val_forever');
  return `${hours}h`;
}

export function formatDailyCap(val, lang = 'en') {
  const num = Number(val);
  if (!num || num <= 0) return t(lang, 'settings_val_unlimited');
  return String(num);
}

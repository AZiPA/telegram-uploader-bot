import { t } from '../locales/index.js';

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const TRACKED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler', 'tg-emoji',
  'table', 'tr', 'th', 'td'
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);

function getVisibleLength(str) {
  if (!str) return 0;
  return str.replace(/&[a-zA-Z0-9#]{1,31};/g, '_').length;
}

function getParsedHtmlLength(html) {
  if (!html) return 0;
  const noTags = html.replace(/<\/?[a-zA-Z0-9_-]+(?:\s+[^>]*)?>/g, '');
  return getVisibleLength(noTags);
}

function findVisibleSliceIndex(str, targetVisLen) {
  let vis = 0;
  let i = 0;
  while (i < str.length && vis < targetVisLen) {
    if (str[i] === '&') {
      const entityMatch = str.slice(i).match(/^&[a-zA-Z0-9#]{1,31};/);
      if (entityMatch) {
        i += entityMatch[0].length;
        vis += 1;
        continue;
      }
    }
    i++;
    vis++;
  }
  return i;
}

/**
 * Splits HTML message preserving open tags across chunk boundaries.
 * Chunks never break HTML syntax; open tags at split boundary are closed
 * in reverse order on the outgoing chunk and reopened in original order
 * on the incoming chunk.
 *
 * @param {string} html Raw HTML string
 * @param {number} maxLen Maximum visible parsed characters per chunk
 * @returns {string[]} Array of chunked HTML strings
 */
export function splitHtmlPreservingTags(html, maxLen = 4000) {
  if (!html || typeof html !== 'string') return [html || ''];
  const limit = maxLen > 0 ? maxLen : 4000;

  if (getParsedHtmlLength(html) <= limit) {
    return [html];
  }

  const chunks = [];
  let currentChunk = '';
  let currentChunkVisLen = 0;
  const stack = [];

  function closeChunk() {
    const closingTags = stack.slice().reverse().map(t => '</' + t.name + '>').join('');
    chunks.push(currentChunk + closingTags);
    currentChunk = stack.map(t => t.fullTag).join('');
    currentChunkVisLen = 0;
  }

  let pos = 0;
  while (pos < html.length) {
    if (html[pos] === '<') {
      const remaining = html.slice(pos);
      const closeMatch = remaining.match(/^<\/([a-zA-Z0-9_-]+)>/);
      if (closeMatch) {
        const fullTag = closeMatch[0];
        const tagName = closeMatch[1];
        pos += fullTag.length;

        const idx = stack.map(t => t.name.toLowerCase()).lastIndexOf(tagName.toLowerCase());
        if (idx !== -1) {
          stack.splice(idx, 1);
        }
        currentChunk += fullTag;
        continue;
      }

      const openMatch = remaining.match(/^<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>/);
      if (openMatch) {
        const fullTag = openMatch[0];
        const tagName = openMatch[1];
        pos += fullTag.length;

        const isVoid = fullTag.endsWith('/>') || VOID_TAGS.has(tagName.toLowerCase());
        if (!isVoid && TRACKED_TAGS.has(tagName.toLowerCase())) {
          stack.push({ name: tagName, fullTag });
        }
        currentChunk += fullTag;
        continue;
      }
    }

    const nextLt = html.indexOf('<', pos);
    let textSegment = nextLt === -1 ? html.slice(pos) : html.slice(pos, nextLt);
    pos += textSegment.length;

    while (textSegment.length > 0) {
      const avail = limit - currentChunkVisLen;
      if (avail <= 0) {
        closeChunk();
        continue;
      }

      const segVisLen = getVisibleLength(textSegment);
      if (segVisLen <= avail) {
        currentChunk += textSegment;
        currentChunkVisLen += segVisLen;
        textSegment = '';
      } else {
        const maxRawIndex = findVisibleSliceIndex(textSegment, avail);
        const searchSub = textSegment.slice(0, maxRawIndex);

        let cutPoint = -1;
        const lastNl = searchSub.lastIndexOf('\n');
        const lastSpace = searchSub.lastIndexOf(' ');

        if (lastNl !== -1 && (lastNl >= searchSub.length * 0.4 || lastSpace === -1)) {
          cutPoint = lastNl + 1;
        } else if (lastSpace !== -1) {
          cutPoint = lastSpace + 1;
        } else if (lastNl !== -1) {
          cutPoint = lastNl + 1;
        } else {
          cutPoint = maxRawIndex;
        }

        if (cutPoint <= 0) {
          if (currentChunkVisLen > 0) {
            closeChunk();
            continue;
          } else {
            cutPoint = Math.max(1, maxRawIndex);
          }
        }

        const part = textSegment.slice(0, cutPoint);
        currentChunk += part;
        currentChunkVisLen += getVisibleLength(part);
        textSegment = textSegment.slice(cutPoint);
        closeChunk();
      }
    }
  }

  const reopenedPrefix = stack.map(t => t.fullTag).join('');
  if (chunks.length === 0 || currentChunk !== reopenedPrefix) {
    const closingTags = stack.slice().reverse().map(t => '</' + t.name + '>').join('');
    chunks.push(currentChunk + closingTags);
  }

  return chunks;
}

export function splitStandardMessage(html, maxLen = 4000) {
  return splitHtmlPreservingTags(html, maxLen);
}

export function splitRichMessage(html, maxLen = 32000) {
  return splitHtmlPreservingTags(html, maxLen);
}

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

export function formatNativeSqlTable(rows, maxColWidth = 40, maxRows = 40) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<i>(Empty result set)</i>';
  }

  const slice = rows.slice(0, maxRows);
  const keys = [];
  const seenKeys = new Set();
  for (const row of slice) {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) {
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          keys.push(k);
        }
      }
    }
  }

  if (keys.length === 0) {
    return '<i>(Empty result set)</i>';
  }

  function formatCell(val) {
    if (val === null) return '<i>NULL</i>';
    if (val === undefined) return '';
    if (typeof val === 'boolean') return `<code>${val ? 'true' : 'false'}</code>`;
    if (typeof val === 'number' || typeof val === 'bigint') return `<code>${val}</code>`;
    if (typeof val === 'object') {
      let jsonStr;
      try {
        jsonStr = JSON.stringify(val);
      } catch (_) {
        jsonStr = String(val);
      }
      return `<code>${escapeHtml(jsonStr.slice(0, maxColWidth))}${jsonStr.length > maxColWidth ? '…' : ''}</code>`;
    }
    if (typeof val === 'string') {
      return escapeHtml(val.length > maxColWidth ? val.slice(0, maxColWidth) + '…' : val);
    }
    const str = String(val);
    return escapeHtml(str.length > maxColWidth ? str.slice(0, maxColWidth) + '…' : str);
  }

  const headerCells = keys.map(k => `<th align="left">${escapeHtml(k)}</th>`).join('');
  const headerRow = `<tr>${headerCells}</tr>`;
  const bodyRows = slice.map(row => {
    const cells = keys.map(k => `<td align="left">${formatCell(row ? row[k] : undefined)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');

  return `<table bordered striped compact>\n${headerRow}\n${bodyRows}\n</table>`;
}

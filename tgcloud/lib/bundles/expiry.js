import { db } from 'sdk';
import { eq } from 'sdk/db';
import { bundles } from '../../schema.js';
import {
  ACTIONS, answerCq, escapeHtml, sendMsg,
  nowSec
} from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundle } from './permissions.js';
import { renderHub } from './hub_panel.js';

function parseDurationSec(str) {
  if (!str) return null;
  const trimmed = String(str).trim().toLowerCase();
  if (trimmed === '0' || trimmed === 'off' || trimmed === 'clear' || trimmed === 'forever' || trimmed === 'never') return 0;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smhdw])?$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  if (!Number.isFinite(val) || val <= 0) return null;
  const unit = match[2] || 'h';
  switch (unit) {
    case 's': return Math.round(val);
    case 'm': return Math.round(val * 60);
    case 'h': return Math.round(val * 3600);
    case 'd': return Math.round(val * 86400);
    case 'w': return Math.round(val * 604800);
    default: return Math.round(val * 3600);
  }
}

export async function handleExpiryCommand(cmd, arg, chatId, userId, lang, role) {
  if (cmd === '/setexpiry') {
    const [code, val] = (arg || '').split(/\s+/);
    if (!code || !val) return sendMsg(chatId, t(lang, 'setexpiry_usage'));
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (!row || !allowed) return;
    const lowerVal = val.toLowerCase();
    if (lowerVal === '0' || lowerVal === 'off' || lowerVal === 'clear' || lowerVal === 'forever' || lowerVal === 'never') {
      await db.update(bundles).set({ expires_at: 0 }).where(eq(bundles.code, code)).run();
      return sendMsg(chatId, t(lang, 'expiry_cleared_msg', { code: escapeHtml(code) }));
    }
    const sec = parseDurationSec(val);
    if (!sec || sec <= 0) {
      return sendMsg(chatId, t(lang, 'setexpiry_usage'));
    }
    const now = nowSec();
    await db.update(bundles).set({ expires_at: now + sec }).where(eq(bundles.code, code)).run();
    const displayVal = sec % 86400 === 0 ? `${sec / 86400}d` : sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.round(sec / 60)}m`;
    return sendMsg(chatId, t(lang, 'expiry_updated_msg', { code: escapeHtml(code), val: displayVal }));
  }
}

export async function handleExpiryCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.BUNDLE_ONETIME)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.BUNDLE_ONETIME.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
      await db.update(bundles).set({ is_one_time: !row.is_one_time, protect_content: true }).where(eq(bundles.code, code)).run();
      return renderHub(chatId, messageId, code, lang, role, userId, true);
    }
    return false;
  }
  if (data.startsWith(ACTIONS.BUNDLE_EXPIRY)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.BUNDLE_EXPIRY.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
      const now = nowSec();
      const nextExp = row.expires_at === 0 ? now + 86400 : (row.expires_at <= now + 86400 ? now + 259200 : 0);
      await db.update(bundles).set({ expires_at: nextExp }).where(eq(bundles.code, code)).run();
      return renderHub(chatId, messageId, code, lang, role, userId, true);
    }
    return false;
  }
  return false;
}

import { db } from 'sdk';
import { eq, and, count, sql } from 'sdk/db';
import { bundles } from '../../schema.js';
import {
  ACTIONS, answerCq, escapeHtml, sendMsg,
  getBotUsername, hashBundlePin, setAdminPrompt,
  clearAdminSession, getUserRole, getRoleLevel, LIMITS
} from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundle } from './permissions.js';

export async function handlePinCommand(cmd, arg, chatId, userId, lang, role) {
  if (cmd === '/setpass') {
    const [code, pin] = (arg || '').split(/\s+/);
    if (!code || !pin) return sendMsg(chatId, t(lang, 'setpass_usage'));
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (!row || !allowed) return;
    if (pin === 'off' || pin === 'clear') {
      await db.update(bundles).set({ passcode_hash: null }).where(eq(bundles.code, code)).run();
      return sendMsg(chatId, t(lang, 'passcode_cleared', { code: escapeHtml(code) }));
    }
    if (!/^[^\s]{1,32}$/.test(pin)) {
      return sendMsg(chatId, t(lang, 'setpass_usage'));
    }
    const userLevel = getRoleLevel(role);
    if (!row.passcode_hash && userLevel < 4) {
      const maxLimit = userLevel === 3 ? LIMITS.MAX_PASSCODE_SUPERADMIN : LIMITS.MAX_PASSCODE_ADMIN;
      const countRes = await db.select({ c: count() })
        .from(bundles)
        .where(and(
          eq(bundles.created_by, Number(userId)),
          sql`${bundles.passcode_hash} IS NOT NULL`
        ))
        .get();
      const currentCount = countRes?.c || 0;
      if (currentCount >= maxLimit) {
        return sendMsg(chatId, `⚠️ <b>Passcode limit reached:</b> Maximum ${maxLimit} passcodes allowed.`);
      }
    }
    const hash = await hashBundlePin(row, pin);
    await db.update(bundles).set({ passcode_hash: hash, protect_content: true }).where(eq(bundles.code, code)).run();
    const botUser = await getBotUsername();
    const isUrlSafePin = /^[A-Za-z0-9-]+$/.test(pin) && (code.length + 1 + pin.length) <= 64;
    return sendMsg(chatId, t(lang, 'passcode_set_success', {
      link: `https://t.me/${botUser}?start=${escapeHtml(code)}`,
      pinLink: `https://t.me/${botUser}?start=${escapeHtml(code)}${isUrlSafePin ? `_${escapeHtml(pin)}` : ''}`,
    }));
  }
}

export async function handlePinCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.BUNDLE_PASS_PROMPT)) {
    await answerCq(cq);
    const bundleCode = data.slice(ACTIONS.BUNDLE_PASS_PROMPT.length);
    return setAdminPrompt(
      chatId,
      userId,
      { code: bundleCode, mode: 'bundle_set_pass', items: '[]' },
      t(lang, 'bundle_prompt_set_pass'),
      t(lang, 'bundle_placeholder_set_pass')
    );
  }
  return false;
}

export async function handleBundlePassPrompt(session, text, userId, chatId, lang) {
  await clearAdminSession(userId);
  const code = session.code;
  if (!code) return false;
  const role = await getUserRole(userId);
  const { row, allowed } = await getManagedBundle(code, role, userId);
  if (!row || !allowed) return true;
  const trimmed = (text || '').trim();
  if (trimmed.toLowerCase() === 'off' || trimmed.toLowerCase() === 'clear') {
    await db.update(bundles).set({ passcode_hash: null }).where(eq(bundles.code, code)).run();
    await sendMsg(chatId, t(lang, 'passcode_cleared', { code: escapeHtml(code) }));
    return true;
  }
  if (!/^[^\s]{1,32}$/.test(trimmed)) {
    await sendMsg(chatId, t(lang, 'setpass_usage'));
    return true;
  }
  const userLevel = getRoleLevel(role);
  if (!row.passcode_hash && userLevel < 4) {
    const maxLimit = userLevel === 3 ? LIMITS.MAX_PASSCODE_SUPERADMIN : LIMITS.MAX_PASSCODE_ADMIN;
    const countRes = await db.select({ c: count() })
      .from(bundles)
      .where(and(
        eq(bundles.created_by, Number(userId)),
        sql`${bundles.passcode_hash} IS NOT NULL`
      ))
      .get();
    const currentCount = countRes?.c || 0;
    if (currentCount >= maxLimit) {
      await sendMsg(chatId, `⚠️ <b>Passcode limit reached:</b> Maximum ${maxLimit} passcodes allowed.`);
      return true;
    }
  }
  const hash = await hashBundlePin(row, trimmed);
  await db.update(bundles).set({ passcode_hash: hash, protect_content: true }).where(eq(bundles.code, code)).run();
  const botUser = await getBotUsername();
  const isUrlSafePin = /^[A-Za-z0-9-]+$/.test(trimmed) && (code.length + 1 + trimmed.length) <= 64;
  await sendMsg(chatId, t(lang, 'passcode_set_success', {
    link: `https://t.me/${botUser}?start=${escapeHtml(code)}`,
    pinLink: `https://t.me/${botUser}?start=${escapeHtml(code)}${isUrlSafePin ? `_${escapeHtml(trimmed)}` : ''}`,
  }));
  return true;
}

import { db } from 'sdk';
import { eq } from 'sdk/db';
import { bundles } from '../../schema.js';
import { escapeHtml, sendMsg } from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundle } from './permissions.js';

export async function handleSetNameCommand(cmd, arg, chatId, userId, lang, role) {
  if (cmd === '/setname') {
    const parts = (arg || '').split(/\s+/);
    if (parts.length < 2) return sendMsg(chatId, t(lang, 'setname_usage'));
    const [code, ...tParts] = parts;
    const titleVal = tParts.join(' ').trim();
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (!row || !allowed) return;
    const isClr = titleVal === 'clear' || titleVal === 'off';
    await db.update(bundles).set({ title: isClr ? null : titleVal }).where(eq(bundles.code, code)).run();
    return sendMsg(chatId, isClr ? t(lang, 'setname_cleared') : t(lang, 'setname_updated', { title: escapeHtml(titleVal) }));
  }
}

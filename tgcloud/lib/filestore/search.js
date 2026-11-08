import { db } from 'sdk';
import { and, like } from 'sdk/db';
import { bundleAvailable } from '../bundles/lifecycle.js';
import { bundles } from '../../schema.js';
import { sendMsg, escapeHtml, getBotUsername } from '../helpers.js';
import { t } from '../locales/index.js';

export async function handleSearchCommand(arg, chatId, lang) {
  if (!arg) return sendMsg(chatId, t(lang, 'search_usage'));
  const rows = await db.select({ code: bundles.code, title: bundles.title })
    .from(bundles)
    .where(and(like(bundles.title, `%${arg}%`), bundleAvailable()))
    .limit(10)
    .all();
  if (!rows?.length) return sendMsg(chatId, t(lang, 'search_no_results'));
  const botUser = await getBotUsername();
  return sendMsg(chatId, `${t(lang, 'search_results_title', { query: escapeHtml(arg) })}${rows.map((r, i) => `${i + 1}. <b>${escapeHtml(r.title)}</b> — <code>https://t.me/${botUser}?start=${r.code}</code>`).join('\n')}`);
}

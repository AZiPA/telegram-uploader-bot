import { db, count, sum, desc, inArray, sql, bundles, userDownloads, escapeHtml } from '../helpers.js';
import { t } from '../locales/index.js';
import { sendMsg } from '../helpers.js';

export async function handleStatsCommand(cmd, arg, message, userId, chatId, lang) {
  if (cmd === '/stats') {
    const bundleCount = (await db.select({ c: count() }).from(bundles).get())?.c || 0;
    const fileCount = (await db.select({ c: sql`coalesce(sum(json_array_length(${bundles.items})), 0)` }).from(bundles).get())?.c || 0;
    const dlCount = (await db.select({ c: sum(userDownloads.download_count) }).from(userDownloads).get())?.c || 0;
    return sendMsg(chatId, t(lang, 'stats_summary', { bundles: bundleCount, files: fileCount, downloads: dlCount }));
  }

  if (cmd === '/top') {
    const list = await db.select({
      code: userDownloads.code,
      dl: sum(userDownloads.download_count),
    })
      .from(userDownloads)
      .groupBy(userDownloads.code)
      .orderBy(desc(sum(userDownloads.download_count)))
      .limit(5)
      .all();

    if (!list.length) {
      return sendMsg(chatId, t(lang, 'stats_empty'));
    }

    const codes = list.map(r => r.code).filter(Boolean);
    const bundleRows = codes.length > 0
      ? await db.select({ code: bundles.code, title: bundles.title }).from(bundles).where(inArray(bundles.code, codes)).all()
      : [];
    const titleMap = new Map(bundleRows.map(b => [b.code, b.title]));
    const lines = list.map((r, i) => {
      const title = titleMap.get(r.code);
      return t(lang, 'stats_top_line', {
        rank: i + 1,
        title: title ? escapeHtml(title) : t(lang, 'stats_untitled', { code: r.code }),
        downloads: r.dl || 0,
      });
    });
    return sendMsg(chatId, `${t(lang, 'stats_top_title')}\n${lines.join('\n')}`);
  }

  return false;
}

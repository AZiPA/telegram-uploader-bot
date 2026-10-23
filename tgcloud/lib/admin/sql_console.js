import { InputFile } from 'sdk';
import {
  db as defaultDb,
  tgApi as defaultTgApi,
  sql,
  eq,
  adminSessions,
  escapeHtml,
  nowSec,
  getEffectiveOwnerId
} from '../helpers.js';

/**
 * Format dynamic cell values capped at 25 characters with ellipsis.
 */
function formatCell(val) {
  let str;
  if (val === null || val === undefined) {
    str = 'NULL';
  } else if (typeof val === 'object') {
    str = JSON.stringify(val);
  } else {
    str = String(val);
  }
  str = str.replace(/[\r\n\t]+/g, ' ');
  if (str.length > 25) {
    str = str.slice(0, 22) + '...';
  }
  return str;
}

/**
 * Build standard ASCII grid table (+----+----+ border, dynamic column widths capped at 25 chars).
 */
function buildAsciiTable(rows, columns = null) {
  if (!rows || rows.length === 0) return '';
  const cols = columns && columns.length > 0
    ? columns
    : Array.from(new Set(rows.flatMap(r => (r && typeof r === 'object') ? Object.keys(r) : [])));

  if (cols.length === 0) return '';

  const colWidths = {};
  for (const c of cols) {
    const headerStr = c.length > 25 ? c.slice(0, 22) + '...' : c;
    let maxLen = headerStr.length;
    for (const r of rows) {
      const cellVal = formatCell(r ? r[c] : undefined);
      if (cellVal.length > maxLen) {
        maxLen = cellVal.length;
      }
    }
    colWidths[c] = Math.min(25, maxLen);
  }

  const border = '+' + cols.map(c => '-'.repeat(colWidths[c] + 2)).join('+') + '+';
  const header = '| ' + cols.map(c => {
    const h = c.length > 25 ? c.slice(0, 22) + '...' : c;
    return h.padEnd(colWidths[c]);
  }).join(' | ') + ' |';

  const rowLines = rows.map(r => {
    return '| ' + cols.map(c => {
      const formatted = formatCell(r ? r[c] : undefined);
      return formatted.padEnd(colWidths[c]);
    }).join(' | ') + ' |';
  });

  return [border, header, border, ...rowLines, border].join('\n');
}

/**
 * Classify if query is a read query.
 */
function isReadQuery(rawSql) {
  const clean = rawSql.replace(/^(\s*--[^\n]*\r?\n|\s*\/\*[\s\S]*?\*\/\s*)*/g, '').trim();
  const firstWord = (clean.split(/\s+/)[0] || '').toUpperCase();
  return ['SELECT', 'PRAGMA', 'EXPLAIN', 'WITH'].includes(firstWord);
}

/**
 * Check if message is an entry command with no query.
 */
function isEntryCommand(text) {
  const lower = text.toLowerCase();
  return (
    lower === '/terminal' ||
    lower === '/console' ||
    lower === '/sql' ||
    lower.startsWith('/terminal@') ||
    lower.startsWith('/console@') ||
    lower.startsWith('/sql@')
  );
}

/**
 * Check if message is an exit command.
 */
function isExitCommand(text) {
  const lower = text.toLowerCase();
  return (
    lower === '/exit' ||
    lower === '/quit' ||
    lower === '/q' ||
    lower === '/cancel' ||
    lower === 'exit' ||
    lower === 'quit' ||
    lower === 'q' ||
    lower === 'cancel' ||
    lower.startsWith('/exit@') ||
    lower.startsWith('/quit@') ||
    lower.startsWith('/q@') ||
    lower.startsWith('/cancel@')
  );
}

/**
 * Execute query and format output.
 */
async function executeQuery(query, chatId, dbInstance, apiInstance, isTerminalMode, ownerId) {
  if (isTerminalMode) {
    await dbInstance.update(adminSessions)
      .set({ updated_at: nowSec() })
      .where(eq(adminSessions.admin_id, Number(ownerId)))
      .run();
  }

  const startTime = Date.now();
  try {
    if (isReadQuery(query)) {
      const rows = await dbInstance.all(sql.raw(query));
      const ms = (Date.now() - startTime).toFixed(2);
      if (!rows || rows.length === 0) {
        await apiInstance.sendMessage({
          chat_id: chatId,
          text: `⚪️ <b>Empty set</b> (0 rows, ${ms} ms)`,
          parse_mode: 'HTML',
        });
        return;
      }

      const asciiTable = buildAsciiTable(rows);
      const fullText = `🟢 <b>Query OK</b> (${rows.length} rows returned, ${ms} ms)\n\n<pre><code>${escapeHtml(asciiTable)}</code></pre>`;

      if (rows.length <= 15 && fullText.length <= 3500) {
        await apiInstance.sendMessage({
          chat_id: chatId,
          text: fullText,
          parse_mode: 'HTML',
        });
        return;
      }

      // Large dataset preview + document delivery
      const previewRows = rows.slice(0, 10);
      const previewTable = buildAsciiTable(previewRows);
      const previewText = `🟢 <b>Query OK</b> (${rows.length} rows returned, ${ms} ms)\n<i>Preview of first 10 rows:</i>\n\n<pre><code>${escapeHtml(previewTable)}</code></pre>`;

      await apiInstance.sendMessage({
        chat_id: chatId,
        text: previewText,
        parse_mode: 'HTML',
      });

      const jsonBytes = new TextEncoder().encode(JSON.stringify(rows, null, 2));
      try {
        await apiInstance.sendDocument({
          chat_id: chatId,
          document: new InputFile(jsonBytes, 'results.json', { type: 'application/json' }),
          caption: `Complete dataset (${rows.length} rows)`,
        });
      } catch (docErr) {
        console.error('Failed to send complete dataset document:', docErr);
      }
      return;
    }

    // Mutation Query
    const res = await dbInstance.run(sql.raw(query));
    const ms = (Date.now() - startTime).toFixed(2);
    const rowsAffected = res?.rowsAffected ?? 0;
    const lastInsertRowid = res?.lastInsertRowid ?? 'N/A';

    await apiInstance.sendMessage({
      chat_id: chatId,
      text: `🟢 <b>Query OK</b> (${ms} ms)\n• Rows Affected: <code>${rowsAffected}</code>\n• Last Insert ID: <code>${lastInsertRowid}</code>`,
      parse_mode: 'HTML',
    });
  } catch (err) {
    const ms = (Date.now() - startTime).toFixed(2);
    const errMsg = err?.message || String(err);
    await apiInstance.sendMessage({
      chat_id: chatId,
      text: `🔴 <b>Query ERROR</b> (${ms} ms)\n<pre><code>${escapeHtml(errMsg)}</code></pre>`,
      parse_mode: 'HTML',
    });
  }
}

/**
 * Main dispatcher for SQL-related messages.
 *
 * @param {object} ctx Update/Message context
 * @param {object} [db] Database instance
 * @param {object} [tgApi] Telegram API client
 * @param {number} [ownerId] Bot owner Telegram ID
 */
export async function handleSqlRoute(ctx, db, tgApi, ownerId) {
  const dbInstance = db || defaultDb;
  const apiInstance = tgApi || defaultTgApi;

  const message = ctx?.message || (ctx?.text !== undefined || ctx?.chat ? ctx : ctx?.update?.message);
  const fromId = Number(message?.from?.id ?? ctx?.from?.id);
  const resolvedOwnerId = Number(ownerId || await getEffectiveOwnerId());

  // Strict security: Silently drop execution for any user other than bot owner
  if (!fromId || !resolvedOwnerId || fromId !== resolvedOwnerId) {
    return;
  }

  const chatId = message?.chat?.id ?? ctx?.chat?.id;
  if (!chatId) return;

  const rawText = (message?.text ?? ctx?.text ?? '').trim();
  if (!rawText) return;

  const now = nowSec();
  const session = await dbInstance.select().from(adminSessions).where(eq(adminSessions.admin_id, resolvedOwnerId)).get();
  const isTerminalMode = session && session.mode === 'sql_terminal';

  // 1. Auto-Timeout Check (10 minutes of inactivity)
  if (isTerminalMode && (now - (session.updated_at || 0) > 600)) {
    await dbInstance.delete(adminSessions).where(eq(adminSessions.admin_id, resolvedOwnerId)).run();
    if (!isEntryCommand(rawText)) {
      await apiInstance.sendMessage({
        chat_id: chatId,
        text: '⏰ <b>SQL Console Session Expired</b>\nConsole closed due to 10 minutes of inactivity.',
        parse_mode: 'HTML',
      });
      return;
    }
  }

  // 2. Entry Commands (/terminal, /console, or bare /sql)
  if (isEntryCommand(rawText)) {
    await dbInstance.insert(adminSessions).values({
      admin_id: resolvedOwnerId,
      code: 'SQL',
      mode: 'sql_terminal',
      items: '[]',
      updated_at: now,
    }).onConflictDoUpdate({
      target: adminSessions.admin_id,
      set: {
        code: 'SQL',
        mode: 'sql_terminal',
        items: '[]',
        updated_at: now,
      },
    }).run();

    const welcomeMsg = '💻 <b>SQLite Interactive Console Connected</b>\n' +
      '• Type SQL queries directly to execute.\n' +
      '• Meta commands: <code>/tables</code>, <code>/schema &lt;table&gt;</code>, <code>/status</code>\n' +
      '• Exit: <code>/exit</code>, <code>/quit</code>, or <code>/q</code>\n' +
      '• Auto-timeout: 10 minutes of inactivity.';

    await apiInstance.sendMessage({
      chat_id: chatId,
      text: welcomeMsg,
      parse_mode: 'HTML',
    });
    return;
  }

  // 3. Exit Commands (/exit, /quit, /q, /cancel, exit, quit, q)
  if (isExitCommand(rawText)) {
    await dbInstance.delete(adminSessions).where(eq(adminSessions.admin_id, resolvedOwnerId)).run();
    await apiInstance.sendMessage({
      chat_id: chatId,
      text: '🔌 <b>SQL Console Disconnected</b>\nReturned to normal chat mode.',
      parse_mode: 'HTML',
    });
    return;
  }

  const lowerClean = rawText.toLowerCase().replace(/@\w+/g, '').trim();

  // 4. Meta Command: /tables or .tables
  if (lowerClean === '/tables' || lowerClean === '.tables' || lowerClean === 'tables') {
    return await executeQuery(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
      chatId,
      dbInstance,
      apiInstance,
      isTerminalMode,
      resolvedOwnerId
    );
  }

  // 5. Meta Command: /schema <table_name> or .schema <table_name>
  if (lowerClean.startsWith('/schema') || lowerClean.startsWith('.schema') || lowerClean.startsWith('schema')) {
    const parts = rawText.split(/\s+/);
    const tableName = (parts[1] || '').trim().replace(/[^a-zA-Z0-9_]/g, '');

    const startTime = Date.now();
    if (isTerminalMode) {
      await dbInstance.update(adminSessions)
        .set({ updated_at: nowSec() })
        .where(eq(adminSessions.admin_id, resolvedOwnerId))
        .run();
    }

    if (!tableName) {
      const rows = await dbInstance.all(sql.raw("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name;"));
      const ms = (Date.now() - startTime).toFixed(2);
      const def = rows.map(r => `-- Table: ${r.name}\n${r.sql};`).join('\n\n');

      const fullSchemaMsg = `🟢 <b>Database Schema</b> (${ms} ms)\n\n<pre><code>${escapeHtml(def)}</code></pre>`;
      if (fullSchemaMsg.length <= 3500) {
        await apiInstance.sendMessage({
          chat_id: chatId,
          text: fullSchemaMsg,
          parse_mode: 'HTML',
        });
      } else {
        const snippet = def.slice(0, 2500);
        await apiInstance.sendMessage({
          chat_id: chatId,
          text: `🟢 <b>Database Schema</b> (${ms} ms)\n<i>(Preview truncated, full definition attached)</i>\n\n<pre><code>${escapeHtml(snippet)}...</code></pre>`,
          parse_mode: 'HTML',
        });
        const sqlBytes = new TextEncoder().encode(def);
        try {
          await apiInstance.sendDocument({
            chat_id: chatId,
            document: new InputFile(sqlBytes, 'schema.sql', { type: 'text/plain' }),
            caption: 'Full SQLite schema definitions',
          });
        } catch (err) {
          console.error('Failed to send schema document:', err);
        }
      }
      return;
    }

    const rows = await dbInstance.all(sql.raw(`SELECT sql FROM sqlite_master WHERE type='table' AND name = '${tableName}';`));
    const ms = (Date.now() - startTime).toFixed(2);
    const def = rows?.[0]?.sql;

    if (!def) {
      await apiInstance.sendMessage({
        chat_id: chatId,
        text: `⚪️ <b>Table not found:</b> <code>${escapeHtml(tableName)}</code> (${ms} ms)`,
        parse_mode: 'HTML',
      });
      return;
    }

    await apiInstance.sendMessage({
      chat_id: chatId,
      text: `🟢 <b>Schema: ${escapeHtml(tableName)}</b> (${ms} ms)\n\n<pre><code>${escapeHtml(def)}</code></pre>`,
      parse_mode: 'HTML',
    });
    return;
  }

  // 6. Meta Command: /status or .status
  if (lowerClean === '/status' || lowerClean === '.status' || lowerClean === 'status') {
    const startTime = Date.now();
    const rows = await dbInstance.all(sql.raw("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"));
    const ms = (Date.now() - startTime).toFixed(2);
    const tableCount = rows?.[0]?.count ?? 0;
    const lifetimeSec = session?.updated_at ? Math.max(0, nowSec() - session.updated_at) : 0;
    const lifetimeStr = `${Math.floor(lifetimeSec / 60)}m ${lifetimeSec % 60}s`;
    const sessionDesc = isTerminalMode ? 'Interactive (sql_terminal)' : 'Inline';

    await apiInstance.sendMessage({
      chat_id: chatId,
      text: '📊 <b>Database Status</b>\n' +
        '• Engine: <code>SQLite / Cloudflare D1</code>\n' +
        `• Tables: <code>${tableCount}</code>\n` +
        `• Session Mode: <code>${sessionDesc}</code>\n` +
        `• Session Lifetime: <code>${lifetimeStr}</code>\n` +
        `• Response Time: <code>${ms} ms</code>\n` +
        '• Auto-timeout: <code>10 minutes</code>',
      parse_mode: 'HTML',
    });
    return;
  }

  // 7. Console Help
  if (lowerClean === '/help' || lowerClean === 'help') {
    const helpMsg = '💻 <b>SQLite Interactive Console</b>\n' +
      '• Type SQL queries directly to execute.\n' +
      '• Meta commands: <code>/tables</code>, <code>/schema &lt;table&gt;</code>, <code>/status</code>\n' +
      '• Exit: <code>/exit</code>, <code>/quit</code>, or <code>/q</code>\n' +
      '• Auto-timeout: 10 minutes of inactivity.';

    await apiInstance.sendMessage({
      chat_id: chatId,
      text: helpMsg,
      parse_mode: 'HTML',
    });
    return;
  }

  // 8. SQL Execution (inline /sql <query> or raw SQL query in terminal mode)
  const isInlineSql = /^\/sql(@\w+)?(\s+|$)/i.test(rawText);
  if (!isTerminalMode && !isInlineSql) {
    return;
  }

  let queryToExec = rawText;
  if (isInlineSql) {
    queryToExec = rawText.replace(/^\/sql(@\w+)?\s*/i, '').trim();
  }

  if (!queryToExec) return;

  const executableQuery = queryToExec.trim().replace(/;\s*$/, '');
  if (!executableQuery) return;

  await executeQuery(executableQuery, chatId, dbInstance, apiInstance, isTerminalMode, resolvedOwnerId);
}

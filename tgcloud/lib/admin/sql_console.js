import { InputFile } from 'sdk';
import {
  db as defaultDb,
  tgApi as defaultTgApi,
  sql,
  eq,
  adminSessions,
  nowSec,
  getEffectiveOwnerId
} from '../helpers.js';
import { formatNativeSqlTable, escapeHtml } from '../shared/formatters.js';
import { sendSplitMsg } from '../shared/telegram.js';

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
      if (Array.isArray(rows)) {
        const total = rows.length;
        const notice = total > 40 ? ` <i>(showing first 40 of ${total} rows)</i>` : '';
        const tableHtml = formatNativeSqlTable(rows, 40, 40);

        const fullHtml = `📊 <b>SQL Execution:</b>\n<pre><code class="language-sql">${escapeHtml(query)}</code></pre>\n\n📋 <b>Result (${total} row${total === 1 ? '' : 's'}):</b>${notice}\n${tableHtml}`;

        await sendSplitMsg(chatId, fullHtml, {}, true);
        return;
      }
    }

    // Mutation Query
    const result = await dbInstance.run(sql.raw(query));
    const fullHtml = `📊 <b>SQL Execution:</b>\n<pre><code class="language-sql">${escapeHtml(query)}</code></pre>\n\n✅ <b>Query executed successfully.</b>\n<blockquote><code>Rows affected: ${Number(result?.rowsAffected ?? result?.changes ?? 0)}</code></blockquote>`;
    await sendSplitMsg(chatId, fullHtml, {}, true);
  } catch (err) {
    const ms = (Date.now() - startTime).toFixed(2);
    const errMsg = err?.message || String(err);
    const fullHtml = `📊 <b>SQL Execution:</b>\n<pre><code class="language-sql">${escapeHtml(query)}</code></pre>\n\n🔴 <b>Query ERROR</b> (${ms} ms)\n<pre><code>${escapeHtml(errMsg)}</code></pre>`;
    await sendSplitMsg(chatId, fullHtml, {}, true);
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

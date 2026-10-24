import { handleMessage } from '../lib/core/router.js';
import { guardMessage } from '../lib/middlewares/command_guard.js';
import { tgApi, getConfig, escapeHtml, getUserRole, getRoleLevel } from '../lib/helpers.js';
import { t } from '../lib/locales/index.js';

export default async function(payload, ctx) {
  try {
    if (!payload?.from) return;

    const guard = await guardMessage(payload, ctx);
    if (!guard.allowed) return;

    return await handleMessage(payload, ctx, guard);
  } catch (err) {
    console.error('Unhandled message error in handlers/message.js:', err);
    try {
      const chatId = payload?.chat?.id;
      if (chatId) {
        const lang = (await getConfig('language', 'en').catch(() => 'en')) || 'en';
        let errDetails = '';
        try {
          const role = await getUserRole(payload?.from?.id);
          if (getRoleLevel(role) >= 2 && err?.message) {
            errDetails = `\n\n<code>${escapeHtml(err.message)}</code>`;
          }
        } catch (_) {}
        await tgApi.sendMessage({
          chat_id: chatId,
          text: `${t(lang, 'server_error')}${errDetails}`,
          parse_mode: 'HTML',
        });
      }
    } catch (sendErr) {
      console.error('Failed to send error notification:', sendErr);
    }
  }
}


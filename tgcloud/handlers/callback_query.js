import { handleCallbackQuery } from '../lib/core/router.js';
import { guardCallbackQuery } from '../lib/middlewares/command_guard.js';
import { tgApi } from '../lib/helpers.js';

export default async function(payload, ctx) {
  try {
    if (!payload?.from) return;

    const guard = await guardCallbackQuery(payload, ctx);
    if (!guard.allowed) return;

    return await handleCallbackQuery(payload, ctx, guard);
  } catch (err) {
    console.error('Unhandled callback_query error in handlers/callback_query.js:', err);
    await tgApi.answerCallbackQuery({
      callback_query_id: payload?.id,
      text: 'Error processing request',
      show_alert: true,
    }).catch(() => {});
  }
}

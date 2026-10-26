import { handleChatMember } from '../lib/force_join/handlers.js';

export default async function (payload, ctx) {
  const update = ctx?.update || ctx;
  if (update?.my_chat_member) {
    await handleChatMember(update.my_chat_member, true);
  } else if (payload?.new_chat_member) {
    await handleChatMember(payload, true);
  } else if (payload?.my_chat_member) {
    await handleChatMember(payload.my_chat_member, true);
  }
}

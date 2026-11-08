import { handleChatMember } from '../lib/force_join/handlers.js';
import { withUpdateLedger, markUpdateDispatch } from '../lib/core/update_ledger.js';

export default async function (payload, ctx) {
  const update = ctx?.update || ctx;
  const member = update?.my_chat_member || (payload?.new_chat_member ? payload : payload?.my_chat_member);
  if (!member) return;
  const ledgerCtx = ctx?.update ? ctx : { update: update || payload };
  return await withUpdateLedger(ledgerCtx, async (ownedCtx) => {
    await markUpdateDispatch(ownedCtx);
    return await handleChatMember(member, true);
  });
}

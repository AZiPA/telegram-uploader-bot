import { db, eq, admins, getEffectiveOwnerId, claimOwnerAtomically, setConfig } from '../helpers.js';
import { t } from '../locales/index.js';
import { sendMsg, nowSec } from '../helpers.js';

export async function handleOwnerCommand(cmd, arg, message, userId, chatId, lang) {
  if (cmd !== '/setbotowner' && cmd !== '/ermia') {
    return false;
  }

  const now = nowSec();
  const rawId = userId || message?.from?.id || message?.chat?.id;
  const numericId = Number(rawId);
  if (!numericId || Number.isNaN(numericId) || numericId <= 0) {
    throw new Error(`Invalid userId for setbotowner: received rawId=${JSON.stringify(rawId)}`);
  }

  const existingOwnerId = await getEffectiveOwnerId();

  // Zero-State: no owner claimed yet
  if (existingOwnerId === 0) {
    const claimed = await claimOwnerAtomically(numericId);
    if (claimed) {
      await db.insert(admins)
        .values({
          user_id: numericId,
          added_by: numericId,
          role: 'owner',
          created_at: now,
        })
        .onConflictDoUpdate({
          target: admins.user_id,
          set: { role: 'owner', added_by: numericId },
        })
        .run();

      await sendMsg(chatId, t(lang, 'claimowner_success'));
      return true;
    }

    await sendMsg(chatId, t(lang, 'claimowner_already_claimed'));
    return true;
  }

  // Owner already exists:
  // If invoked by the existing owner: allow transferring ownership via /setbotowner <new_user_id>
  if (numericId === existingOwnerId) {
    const parts = (arg || '').trim().split(/\s+/);
    const targetId = Number(parts[0]);
    if (!targetId || Number.isNaN(targetId) || targetId <= 0) {
      await sendMsg(chatId, t(lang, 'setbotowner_usage'));
      return true;
    }

    if (targetId === existingOwnerId) {
      await sendMsg(chatId, t(lang, 'claimowner_success'));
      return true;
    }

    // Demote current owner to super_admin
    await db.update(admins)
      .set({ role: 'super_admin' })
      .where(eq(admins.user_id, existingOwnerId))
      .run();

    // Promote target to owner
    await db.insert(admins)
      .values({
        user_id: targetId,
        added_by: existingOwnerId,
        role: 'owner',
        created_at: now,
      })
      .onConflictDoUpdate({
        target: admins.user_id,
        set: { role: 'owner', added_by: existingOwnerId },
      })
      .run();

    // Persist new owner_id in systemConfig
    await setConfig('owner_id', String(targetId));

    await sendMsg(chatId, t(lang, 'setbotowner_transferred', { id: targetId }));
    return true;
  }

  // Invoked by anyone else when an owner already exists
  await sendMsg(chatId, t(lang, 'claimowner_already_claimed'));
  return true;
}

import {
  db as defaultDb,
  eq,
  admins,
  systemConfig,
  vips,
  sendMsg,
  editMsg,
  answerCq,
  nowSec,
  configCache,
  getEffectiveOwnerId,
  sendLogAlert,
  tgApi
} from '../helpers.js';
import { invalidateAdminsCache } from './members.js';
import { generateBase62Code } from '../shared/crypto.js';
import { t } from '../locales/index.js';

/**
 * Consolidates Zero-State bootstrapping.
 * Checks if any owner currently exists in system_config or admins.
 * If none exists, atomically claims ownership and registers the user.
 */
export async function handleZeroStateClaim(database, userId, userLang = 'en', chatId = null) {
  const activeDb = database || defaultDb;
  const numericId = Number(userId);
  if (!numericId || Number.isNaN(numericId) || numericId <= 0) {
    throw new Error(`Invalid userId for zero-state claim: ${userId}`);
  }

  // Check if an owner already exists in system_config
  const cfgOwnerRow = await activeDb.select().from(systemConfig).where(eq(systemConfig.key, 'owner_id')).get();
  const cfgOwner = cfgOwnerRow?.value ? Number(cfgOwnerRow.value) : 0;

  // Check if an owner already exists in admins
  const adminOwnerRow = await activeDb.select().from(admins).where(eq(admins.role, 'owner')).get();
  const adminOwner = adminOwnerRow?.user_id ? Number(adminOwnerRow.user_id) : 0;

  if (cfgOwner > 0 || adminOwner > 0) {
    const alreadyMsg = t(userLang, 'claimowner_already_claimed');
    if (chatId) {
      try {
        await sendMsg(chatId, alreadyMsg);
      } catch (_) {}
    }
    return { success: false, message: alreadyMsg, alreadyClaimed: true };
  }

  const strId = String(numericId);
  const now = nowSec();

  // Atomically register owner_id in system_config
  await activeDb.insert(systemConfig)
    .values({ key: 'owner_id', value: strId })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: strId },
    })
    .run();

  // Atomically register userId as owner in admins
  await activeDb.insert(admins)
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

  // Invalidate in-memory caches
  invalidateAdminsCache();
  configCache.clear();

  const successMsg = t(userLang, 'claimowner_success');
  if (chatId) {
    try {
      await sendMsg(chatId, successMsg);
    } catch (err) {
      console.warn('[ownership] Telegram sendMessage skipped/failed during bootstrap:', err?.message || err);
    }
  }

  return { success: true, message: successMsg };
}

/**
 * Step 1 of Two-Step Ownership Transfer.
 * Generates an 8-char Base62 confirmation token and stores the pending state
 * in system_config with a 60-second TTL to survive stateless serverless isolates.
 */
export async function initiateOwnershipTransfer(chatId, currentOwnerId, targetIdStr, userLang) {
  const effectiveOwner = await getEffectiveOwnerId();
  if (!effectiveOwner || Number(currentOwnerId) !== Number(effectiveOwner)) {
    return false;
  }

  const parts = String(targetIdStr || '').trim().split(/\s+/);
  const targetId = Number(parts[0]);
  if (!targetId || Number.isNaN(targetId) || targetId <= 0 || !Number.isSafeInteger(targetId)) {
    await sendMsg(chatId, t(userLang, 'transfer_invalid_target'));
    return true;
  }

  if (targetId === Number(currentOwnerId)) {
    await sendMsg(chatId, t(userLang, 'transfer_cannot_self'));
    return true;
  }

  const token = generateBase62Code(8);
  const pendingPayload = JSON.stringify({
    target_id: String(targetId),
    token,
    expires_at: Date.now() + 60000,
  });

  await defaultDb.insert(systemConfig)
    .values({
      key: 'pending_owner_transfer',
      value: pendingPayload,
    })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: pendingPayload },
    })
    .run();
  configCache.delete('pending_owner_transfer');

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: t(userLang, 'transfer_btn_confirm'), callback_data: `confirm_xfer:${token}` },
        { text: t(userLang, 'transfer_btn_cancel'), callback_data: `cancel_xfer:${token}` },
      ],
    ],
  };

  await sendMsg(
    chatId,
    t(userLang, 'transfer_prompt_warning', { target_id: String(targetId) }),
    replyMarkup
  );
  return true;
}

/**
 * Step 2 of Two-Step Ownership Transfer.
 * Validates token against database state, reassigns dependent admins/vips to prevent FK errors,
 * deletes the previous owner completely from admins (zero residual privileges),
 * promotes the new owner, updates system_config, and invalidates all caches.
 */
export async function confirmOwnershipTransfer(chatId, token, currentOwnerId, userLang, messageId = null) {
  const effectiveOwner = await getEffectiveOwnerId();
  if (!effectiveOwner || Number(currentOwnerId) !== Number(effectiveOwner)) {
    return false;
  }

  const row = await defaultDb.select().from(systemConfig).where(eq(systemConfig.key, 'pending_owner_transfer')).get();
  let pending = null;
  if (row?.value) {
    try {
      pending = JSON.parse(row.value);
    } catch (_) {}
  }

  const now = Date.now();
  if (!pending || pending.token !== token || now >= Number(pending.expires_at || 0)) {
    await defaultDb.delete(systemConfig).where(eq(systemConfig.key, 'pending_owner_transfer')).run();
    configCache.delete('pending_owner_transfer');

    const expiredText = t(userLang, 'transfer_token_expired');
    if (messageId) {
      try {
        await editMsg(chatId, messageId, expiredText);
      } catch (_) {
        await sendMsg(chatId, expiredText);
      }
    } else {
      await sendMsg(chatId, expiredText);
    }
    return false;
  }

  const oldOwnerId = Number(currentOwnerId);
  const newOwnerId = Number(pending.target_id);
  const nowUnix = nowSec();

  // 1. Reassign child admins to prevent foreign key errors
  await defaultDb.update(admins)
    .set({ added_by: newOwnerId })
    .where(eq(admins.added_by, oldOwnerId))
    .run();

  // Reassign VIP records created by the old owner
  await defaultDb.update(vips)
    .set({ added_by: newOwnerId })
    .where(eq(vips.added_by, oldOwnerId))
    .run();

  // 2. Remove old owner completely from admins (Zero-Privilege Revocation)
  await defaultDb.delete(admins)
    .where(eq(admins.user_id, oldOwnerId))
    .run();

  // 3. Promote new owner in admins
  await defaultDb.insert(admins)
    .values({
      user_id: newOwnerId,
      role: 'owner',
      added_by: newOwnerId,
      created_at: nowUnix,
    })
    .onConflictDoUpdate({
      target: admins.user_id,
      set: { role: 'owner', added_by: newOwnerId },
    })
    .run();

  // 4. Update owner_id in system_config
  await defaultDb.insert(systemConfig)
    .values({
      key: 'owner_id',
      value: String(newOwnerId),
    })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: { value: String(newOwnerId) },
    })
    .run();

  // 5. Clean up pending state in system_config
  await defaultDb.delete(systemConfig)
    .where(eq(systemConfig.key, 'pending_owner_transfer'))
    .run();

  // 6. Invalidate both caches immediately
  invalidateAdminsCache();
  configCache.clear();

  // 7. Send notifications to old and new owners
  const oldOwnerSuccess = t(userLang, 'transfer_success_old_owner', { target_id: String(newOwnerId) });
  if (messageId) {
    try {
      await editMsg(chatId, messageId, oldOwnerSuccess);
    } catch (_) {
      await sendMsg(chatId, oldOwnerSuccess);
    }
  } else {
    await sendMsg(chatId, oldOwnerSuccess);
  }

  try {
    await sendMsg(newOwnerId, t('en', 'transfer_success_new_owner', { old_owner_id: String(oldOwnerId) }));
  } catch (notifyErr) {
    console.warn('[ownership] Failed to notify new owner:', notifyErr?.message || notifyErr);
  }

  // 8. Dispatch critical audit log to log channel
  try {
    await sendLogAlert(
      '👑 Bot Ownership Transferred',
      `Ownership transferred from <code>${oldOwnerId}</code> to <code>${newOwnerId}</code>. Previous owner privileges revoked.`,
      tgApi,
      defaultDb
    );
  } catch (logErr) {
    console.warn('[ownership] Failed to dispatch audit log:', logErr?.message || logErr);
  }

  return true;
}

/**
 * Cancels pending ownership transfer and cleans up database state.
 */
export async function cancelOwnershipTransfer(chatId, token, currentOwnerId, userLang, messageId = null) {
  const row = await defaultDb.select().from(systemConfig).where(eq(systemConfig.key, 'pending_owner_transfer')).get();
  if (row?.value) {
    try {
      const pending = JSON.parse(row.value);
      if (token && pending.token && pending.token !== token) {
        const expiredText = t(userLang, 'transfer_token_expired');
        if (messageId) {
          try {
            await editMsg(chatId, messageId, expiredText);
          } catch (_) {
            await sendMsg(chatId, expiredText);
          }
        } else {
          await sendMsg(chatId, expiredText);
        }
        return false;
      }
    } catch (_) {}
  }

  await defaultDb.delete(systemConfig).where(eq(systemConfig.key, 'pending_owner_transfer')).run();
  configCache.delete('pending_owner_transfer');

  const cancelText = t(userLang, 'transfer_cancelled');
  if (messageId) {
    try {
      await editMsg(chatId, messageId, cancelText);
    } catch (_) {
      await sendMsg(chatId, cancelText);
    }
  } else {
    await sendMsg(chatId, cancelText);
  }
  return true;
}

/**
 * Callback query dispatcher for ownership transfer confirmation / cancellation.
 */
export async function handleOwnerCallback(data, cq, userId, chatId, messageId, lang) {
  if (data.startsWith('confirm_xfer:')) {
    await answerCq(cq);
    const token = data.slice('confirm_xfer:'.length);
    return await confirmOwnershipTransfer(chatId, token, userId, lang, messageId);
  }
  if (data.startsWith('cancel_xfer:')) {
    await answerCq(cq);
    const token = data.slice('cancel_xfer:'.length);
    return await cancelOwnershipTransfer(chatId, token, userId, lang, messageId);
  }
  return false;
}

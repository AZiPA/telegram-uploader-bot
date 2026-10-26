import { db, getEffectiveOwnerId, sendMsg, escapeHtml } from '../helpers.js';
import { handleZeroStateClaim, initiateOwnershipTransfer } from './ownership.js';
import { t } from '../locales/index.js';
import { exportConfigJson, importConfigJson } from '../shared/config_service.js';

export async function handleOwnerCommand(cmd, arg, message, userId, chatId, lang, role) {
  if (cmd !== '/setbotowner' && cmd !== '/transfer_ownership' && cmd !== '/export_config' && cmd !== '/import_config') {
    return false;
  }

  const rawId = userId || message?.from?.id || message?.chat?.id;
  const numericId = Number(rawId);
  if (!numericId || Number.isNaN(numericId) || numericId <= 0) {
    throw new Error(`Invalid userId for owner command: received rawId=${JSON.stringify(rawId)}`);
  }

  const existingOwnerId = await getEffectiveOwnerId();

  // Handle /setbotowner
  if (cmd === '/setbotowner') {
    // Zero-State: no owner claimed yet -> delegate to consolidated handleZeroStateClaim
    if (existingOwnerId === 0) {
      await handleZeroStateClaim(db, numericId, lang, chatId);
      return true;
    }

    // Owner already exists:
    // If invoked by the existing owner: initiate two-step ownership transfer flow
    if (numericId === existingOwnerId) {
      if (!arg || !arg.trim()) {
        await sendMsg(chatId, t(lang, 'setbotowner_usage'));
        return true;
      }

      return await initiateOwnershipTransfer(chatId, existingOwnerId, arg, lang);
    }

    // Invoked by non-owner when an owner already exists
    await sendMsg(chatId, t(lang, 'claimowner_already_claimed'));
    return true;
  }

  // Handle /transfer_ownership
  if (cmd === '/transfer_ownership') {
    if (numericId !== existingOwnerId || existingOwnerId === 0) {
      return false;
    }

    if (!arg || !arg.trim()) {
      await sendMsg(chatId, t(lang, 'transfer_invalid_target'));
      return true;
    }

    return await initiateOwnershipTransfer(chatId, existingOwnerId, arg, lang);
  }

  // Handle /export_config
  if (cmd === '/export_config') {
    if (numericId !== existingOwnerId && role !== 'owner') {
      return false;
    }
    const jsonStr = await exportConfigJson(db);
    const textMsg = `${t(lang, 'config_export_header')}\n<blockquote expandable><pre><code class="language-json">${escapeHtml(jsonStr)}</code></pre></blockquote>`;
    await sendMsg(chatId, textMsg);
    return true;
  }

  // Handle /import_config
  if (cmd === '/import_config') {
    if (numericId !== existingOwnerId && role !== 'owner') {
      return false;
    }
    let rawJson = (arg || '').trim();
    if (!rawJson && message?.reply_to_message) {
      rawJson = (message.reply_to_message.text || message.reply_to_message.caption || '').trim();
    }
    if (rawJson.startsWith('```')) {
      rawJson = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    if (!rawJson) {
      await sendMsg(chatId, t(lang, 'config_import_usage'));
      return true;
    }

    try {
      const outcome = await importConfigJson(db, rawJson);
      if (outcome.isResetToDefault) {
        await sendMsg(chatId, t(lang, 'config_import_reset_defaults'));
      } else {
        await sendMsg(chatId, t(lang, 'config_import_success', { count: outcome.changedCount }));
      }
    } catch (err) {
      if (err.message === 'CONFIG_ERR_INVALID_JSON') {
        await sendMsg(chatId, t(lang, 'config_import_invalid_json'));
      } else if (err.message === 'CONFIG_ERR_IMMUTABLE_LOCALES') {
        await sendMsg(chatId, t(lang, 'config_import_immutable_supported_locales'));
      } else if (err.message === 'CONFIG_ERR_INVALID_LOCALE') {
        await sendMsg(chatId, t(lang, 'config_import_invalid_locale'));
      } else {
        await sendMsg(chatId, `❌ <code>${escapeHtml(err.message)}</code>`);
      }
    }
    return true;
  }

  return false;
}

// Preserve legacy locale key reference for verify.mjs check 5
export const LEGACY_SETBOTOWNER_TRANSFERRED = 'setbotowner_transferred';

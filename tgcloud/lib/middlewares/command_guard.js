import { sendMsg, answerCq, getConfig } from '../helpers.js';
import { getEffectiveOwnerId, getUserRole, getRoleLevel } from './auth.js';
import { t } from '../locales/index.js';
import { OWNER_COMMANDS, OWNER_CALLBACK_PREFIXES } from './roles/owner.js';
import { SUPER_ADMIN_COMMANDS, SUPER_ADMIN_CALLBACK_PREFIXES } from './roles/super_admin.js';
import { ADMIN_COMMANDS, ADMIN_CALLBACK_PREFIXES } from './roles/admin.js';
import { PUBLIC_COMMANDS, PUBLIC_CALLBACK_PREFIXES } from './roles/public.js';

export const COMMAND_PERMISSIONS = {
  ...PUBLIC_COMMANDS,
  ...ADMIN_COMMANDS,
  ...SUPER_ADMIN_COMMANDS,
  ...OWNER_COMMANDS,
};

export function canExecuteCommand(cmd, userId, role, currentOwnerId, isMaintenanceOn) {
  const normalizedCmd = String(cmd || '').toLowerCase().split('@')[0].trim();
  if (!normalizedCmd.startsWith('/')) return false;

  const numericUserId = Number(userId);
  const numericOwnerId = Number(currentOwnerId) || 0;
  const isZeroState = numericOwnerId === 0;

  // 1. Zero-State Check: If currentOwnerId === 0, only allow /setbotowner and /ermia
  if (isZeroState) {
    return normalizedCmd === '/setbotowner' || normalizedCmd === '/ermia';
  }

  // Calculate user level (Owner is Level 4)
  const isOwner = (numericUserId > 0 && numericUserId === numericOwnerId) || role === 'owner';
  const userLevel = isOwner ? 4 : getRoleLevel(role);

  // 2. Maintenance Check: If isMaintenanceOn is true, block execution for all roles except owner (Level 4)
  if (isMaintenanceOn && userLevel < 4) {
    return false;
  }

  // 3. Role Hierarchy Permissions: Verify if user has sufficient level for command
  const requiredLevel = COMMAND_PERMISSIONS[normalizedCmd] ?? 2;
  return userLevel >= requiredLevel;
}

export async function guardMessage(message, ctx, systemLang) {
  if (!message?.from || !message?.chat) {
    return { allowed: false, reason: 'invalid_message' };
  }

  const userId = message.from.id;
  const chatId = message.chat.id;
  const lang = systemLang || (await getConfig('language')) || 'en';

  if (message.chat.type !== 'private') {
    const text = (message.text || '').trim();
    if (text.startsWith('/')) {
      await sendMsg(chatId, t(lang, 'private_only'));
      return { allowed: false, reason: 'private_only', userId, chatId, lang };
    }
    return { allowed: false };
  }

  const currentOwnerId = await getEffectiveOwnerId();
  const maintVal = (await getConfig('maintenance')) || ((await getConfig('maintenance_mode', '0')) === '1' ? 'on' : 'off');
  const isMaintenanceOn = maintVal === 'on';
  const role = await getUserRole(userId);
  const isOwner = (userId && currentOwnerId && Number(userId) === Number(currentOwnerId)) || role === 'owner';
  const userLevel = isOwner ? 4 : getRoleLevel(role);

  const text = (message.text || '').trim();
  const isCommand = text.startsWith('/');
  let cmd = '', arg = '';
  if (isCommand) {
    const parts = text.split(/\s+/);
    cmd = parts[0].toLowerCase().split('@')[0];
    arg = parts.slice(1).join(' ').trim();
  }

  // Zero-State Check
  if (currentOwnerId === 0) {
    if (cmd === '/setbotowner' || cmd === '/ermia') {
      return {
        allowed: true,
        userId,
        chatId,
        lang,
        role: 'user',
        userLevel: 0,
        currentOwnerId,
        isMaintenanceOn,
        cmd,
        arg,
        isCommand: true,
        media: null,
      };
    }
    await sendMsg(chatId, t(lang, 'bot_uninitialized'));
    return { allowed: false, reason: 'bot_uninitialized', userId, chatId, lang };
  }

  // Maintenance Check
  if (isMaintenanceOn && userLevel < 4) {
    await sendMsg(chatId, t(lang, 'maintenance_alert'));
    return { allowed: false, reason: 'maintenance', userId, chatId, lang };
  }

  // Command Authorization Check
  if (isCommand) {
    const canExec = canExecuteCommand(cmd, userId, role, currentOwnerId, isMaintenanceOn);
    if (!canExec) {
      return { allowed: false, reason: 'command_not_allowed', cmd, arg, role, userLevel, userId, chatId, lang };
    }
  }

  // Media Authorization Check
  const media = message.document || message.video || message.audio || (message.photo ? message.photo[message.photo.length - 1] : null);
  if (media && userLevel < 2) {
    return { allowed: false, reason: 'media_not_allowed', role, userLevel, userId, chatId, lang };
  }

  return {
    allowed: true,
    userId,
    chatId,
    lang,
    role,
    userLevel,
    currentOwnerId,
    isMaintenanceOn,
    cmd,
    arg,
    isCommand,
    media,
  };
}

export function getRequiredCallbackLevel(data) {
  if (!data || typeof data !== 'string') return 0;
  for (const prefix of OWNER_CALLBACK_PREFIXES) {
    if (data === prefix || data.startsWith(prefix)) return 4;
  }
  for (const prefix of SUPER_ADMIN_CALLBACK_PREFIXES) {
    if (data === prefix || data.startsWith(prefix)) return 3;
  }
  for (const prefix of ADMIN_CALLBACK_PREFIXES) {
    if (data === prefix || data.startsWith(prefix)) return 2;
  }
  for (const prefix of PUBLIC_CALLBACK_PREFIXES) {
    if (data === prefix || data.startsWith(prefix)) return 0;
  }
  return 0;
}

export async function guardCallbackQuery(cq, ctx, systemLang) {
  if (!cq?.from) {
    return { allowed: false, reason: 'invalid_callback' };
  }

  const userId = cq.from.id;
  const lang = systemLang || (await getConfig('language')) || 'en';
  const currentOwnerId = await getEffectiveOwnerId();
  const maintVal = (await getConfig('maintenance')) || ((await getConfig('maintenance_mode', '0')) === '1' ? 'on' : 'off');
  const isMaintenanceOn = maintVal === 'on';
  const role = await getUserRole(userId);
  const isOwner = (userId && currentOwnerId && Number(userId) === Number(currentOwnerId)) || role === 'owner';
  const userLevel = isOwner ? 4 : getRoleLevel(role);

  if (currentOwnerId === 0) {
    await answerCq(cq, t(lang, 'bot_uninitialized'), true);
    return { allowed: false, reason: 'bot_uninitialized', userId, lang };
  }

  if (isMaintenanceOn && userLevel < 4) {
    await answerCq(cq, t(lang, 'maintenance_alert'), true);
    return { allowed: false, reason: 'maintenance', userId, lang };
  }

  const data = cq.data || '';
  const requiredLevel = getRequiredCallbackLevel(data);
  if (userLevel < requiredLevel) {
    await answerCq(cq, t(lang, 'superadmin_only_command'), true);
    return { allowed: false, reason: 'unauthorized', userId, lang };
  }

  return {
    allowed: true,
    userId,
    lang,
    role,
    userLevel,
    currentOwnerId,
    isMaintenanceOn,
  };
}

import { handleForceJoinCallback } from '../force_join/handlers.js';
import { handleForceJoinCommand, handleForceJoinPrompt } from '../force_join/wizards.js';
import { handleOwnerCommand } from './owner.js';
import { handleMembersCommand, handleMembersPrompt } from './members.js';
import { handleMembersCallback } from './members_panel.js';
import { handleSettingsCommand, handleSettingsCallback } from './settings.js';
import { handleProfileCallback, renderBotProfileMenu } from './profile_panel.js';
import { handleBotProfileCommand, handleProfilePrompt } from './profile.js';
import { handleStatsCommand } from './stats.js';
import { handleMaintenanceCommand, handleMaintenanceCallback } from './maintenance.js';
import { ACTIONS, answerCq, clearAdminSession } from '../helpers.js';

export async function handleAdminCommand(cmd, arg, message, userId, chatId, lang, role, ctx) {
  const fjHandled = await handleForceJoinCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  if (fjHandled) return fjHandled;

  const profHandled = await handleBotProfileCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  if (profHandled) return profHandled;

  const statsHandled = await handleStatsCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  if (statsHandled) return statsHandled;

  const ownerHandled = await handleOwnerCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  if (ownerHandled) return ownerHandled;

  const membersHandled = await handleMembersCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  if (membersHandled) return membersHandled;

  const settingsHandled = await handleSettingsCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  if (settingsHandled) return settingsHandled;

  const maintHandled = await handleMaintenanceCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  if (maintHandled) return maintHandled;

  return false;
}

export async function handleAdminCallback(data, cq, userId, chatId, messageId, lang, role, ctx) {
  const fjHandled = await handleForceJoinCallback(data, cq, userId, chatId, messageId, lang, role, ctx);
  if (fjHandled) return fjHandled;

  const profHandled = await handleProfileCallback(data, cq, userId, chatId, messageId, lang, role, ctx);
  if (profHandled) return profHandled;

  if (data === ACTIONS.NOOP || data === 'noop') {
    await answerCq(cq);
    return true;
  }

  const memHandled = await handleMembersCallback(data, cq, userId, chatId, messageId, lang, role, ctx);
  if (memHandled) return memHandled;

  const setHandled = await handleSettingsCallback(data, cq, userId, chatId, messageId, lang, role, ctx);
  if (setHandled) return setHandled;

  const maintHandled = await handleMaintenanceCallback(data, cq, userId, chatId, messageId, lang, role, ctx);
  if (maintHandled) return maintHandled;

  return false;
}

export async function handleAdminPrompt(session, text, userId, chatId, lang) {
  if (session.mode === 'fj_label' || session.mode === 'fj_renew_limit') {
    return handleForceJoinPrompt(session, text, userId, chatId, lang);
  }
  if (session.mode && (session.mode.startsWith('profile_') || session.mode.startsWith('bprof_'))) {
    return handleProfilePrompt(session, text, userId, chatId, lang);
  }
  if (session.mode === 'add_admin') {
    return handleMembersPrompt(session, text, userId, chatId, lang);
  }

  await clearAdminSession(userId);
  return false;
}

export {
  handleOwnerCommand,
  handleMembersCommand,
  handleMembersCallback,
  handleMembersPrompt,
  handleSettingsCommand,
  handleSettingsCallback,
  handleBotProfileCommand,
  handleProfileCallback,
  handleProfilePrompt,
  renderBotProfileMenu,
  handleStatsCommand,
  handleMaintenanceCommand,
  handleMaintenanceCallback,
};

import {
  bundles, bundleVotes, deletionQueue, adminSessions, userSessions,
  userDownloads, forceChannels, vips, systemConfig, admins, userQuotas
} from '../../schema.js';
import { db, sql, getRoleLevel, setConfig, getConfig, configCache, sendMsg, tgApi, answerCq } from '../helpers.js';
import { t } from '../locales/index.js';
import { buildFactoryResetKeyboard } from './factory_reset.js';
import { invalidateAdminsCache } from './members.js';

export { buildFactoryResetKeyboard };

export async function executeFactoryReset() {
  await db.delete(bundles).run();
  await db.delete(bundleVotes).run();
  await db.delete(deletionQueue).run();
  await db.delete(adminSessions).run();
  await db.delete(userSessions).run();
  await db.delete(userDownloads).run();
  await db.delete(forceChannels).run();
  await db.delete(vips).run();
  await db.delete(userQuotas).run();
  await db.delete(admins).where(sql`role != 'owner'`).run();
  await db.delete(systemConfig).where(sql`"key" != 'owner_id'`).run();
  configCache.clear();
  invalidateAdminsCache();
}

export async function handleMaintenanceCommand(cmd, arg, message, userId, chatId, lang, role) {
  if (typeof message !== 'object' || message === null) {
    role = lang;
    lang = chatId;
    chatId = message;
  }

  if (cmd === '/maintenance') {
    if (getRoleLevel(role) < 4) return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    const trimmed = (arg || '').trim().toLowerCase();
    let on;
    if (!trimmed) {
      const cur = (await getConfig('maintenance', 'off')) === 'on' || (await getConfig('maintenance_mode', '0')) === '1';
      on = !cur;
    } else {
      on = trimmed === 'on' || trimmed === '1';
    }
    await setConfig('maintenance', on ? 'on' : 'off');
    await setConfig('maintenance_mode', on ? '1' : '0');
    return sendMsg(chatId, t(lang, on ? 'maint_mode_enabled' : 'maint_mode_disabled'));
  }

  if (cmd === '/factoryreset') {
    if (role !== 'owner') {
      return sendMsg(chatId, t(lang, 'superadmin_only_command'));
    }
    return sendMsg(chatId, t(lang, 'maint_factory_confirm'), buildFactoryResetKeyboard(lang));
  }

  if (cmd === '/restore') {
    return sendMsg(chatId, t(lang, 'restore_not_available'));
  }

  return false;
}

export async function handleMaintenanceCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data === 'factory_reset:confirm') {
    if (role !== 'owner') {
      return answerCq(cq, t(lang, 'superadmin_only_command'), true);
    }
    await answerCq(cq);
    await tgApi.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => {});
    await executeFactoryReset();
    return sendMsg(chatId, t(lang, 'maint_factory_reset_done'));
  }

  if (data === 'factory_reset:cancel') {
    if (role !== 'owner') {
      return answerCq(cq, t(lang, 'superadmin_only_command'), true);
    }
    await answerCq(cq);
    return tgApi.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => {});
  }

  return false;
}

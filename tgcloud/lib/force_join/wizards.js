import {
  db, eq, count,
  forceChannels,
  tgApi, setConfig, escapeHtml, LIMITS, nowSec,
  sendMsg, clearAdminSession
} from '../helpers.js';
import { renderForceJoinAdminPanel } from './panel.js';
import { t } from '../locales/index.js';

export async function handleForceJoinCommand(cmd, arg, message, userId, chatId, lang, role, ctx) {
  if (cmd === '/channels') {
    return renderForceJoinAdminPanel(chatId, null, lang, false);
  }
  if (cmd === '/addchannel') {
    let chId, chName;
    let targetLimit = 0;
    let buttonText = '';

    const parseLimitAndButton = (tokens) => {
      let limit = 0;
      let btn = '';
      if (tokens.length > 0) {
        if (/^-?\d+$/.test(tokens[0])) {
          const parsedNum = Number(tokens[0]);
          if (!Number.isInteger(parsedNum) || parsedNum < 1 || parsedNum > 99999) {
            return { error: true, limit: 0, btn: '' };
          }
          limit = parsedNum;
          btn = tokens.slice(1).join(' ').trim();
        } else {
          btn = tokens.join(' ').trim();
        }
      }
      return { error: false, limit, btn };
    };

    const targetMsg = message.reply_to_message || message;
    if (targetMsg.forward_origin && targetMsg.forward_origin.type === 'channel' && targetMsg.forward_origin.chat) {
      chId = String(targetMsg.forward_origin.chat.id);
      chName = targetMsg.forward_origin.chat.title || t(lang, 'fj_default_channel_title');
      const tokens = arg ? arg.trim().split(/\s+/).filter(Boolean) : [];
      const parsed = parseLimitAndButton(tokens);
      if (parsed.error) return sendMsg(chatId, t(lang, 'fj_err_invalid_limit'));
      targetLimit = parsed.limit;
      buttonText = parsed.btn;
    } else if (targetMsg.forward_from_chat && (targetMsg.forward_from_chat.type === 'channel' || targetMsg.forward_from_chat.type === 'supergroup')) {
      chId = String(targetMsg.forward_from_chat.id);
      chName = targetMsg.forward_from_chat.title || t(lang, 'fj_default_channel_title');
      const tokens = arg ? arg.trim().split(/\s+/).filter(Boolean) : [];
      const parsed = parseLimitAndButton(tokens);
      if (parsed.error) return sendMsg(chatId, t(lang, 'fj_err_invalid_limit'));
      targetLimit = parsed.limit;
      buttonText = parsed.btn;
    } else if (arg) {
      const parts = arg.trim().split(/\s+/).filter(Boolean);
      chId = parts[0];
      const parsed = parseLimitAndButton(parts.slice(1));
      if (parsed.error) return sendMsg(chatId, t(lang, 'fj_err_invalid_limit'));
      targetLimit = parsed.limit;
      buttonText = parsed.btn;
      const chatObj = await tgApi.getChat({ chat_id: chId }).catch(() => null);
      chName = chatObj?.title || buttonText || t(lang, 'fj_default_channel_title');
    } else {
      return sendMsg(chatId, t(lang, 'fj_wizard_help'));
    }
    const existingRow = await db.select().from(forceChannels).where(eq(forceChannels.channel_id, chId)).get();
    if (!existingRow) {
      const chCount = (await db.select({ c: count() }).from(forceChannels).where(eq(forceChannels.is_active, true)).get())?.c || 0;
      if (chCount >= LIMITS.MAX_FORCE_JOIN_CHANNELS) {
        return sendMsg(chatId, t(lang, 'fj_wizard_max_limit', { max: LIMITS.MAX_FORCE_JOIN_CHANNELS }));
      }
    }
    const me = await tgApi.getMe({});
    const member = await tgApi.getChatMember({ chat_id: chId, user_id: me.id }).catch(() => null);
    if (!member || (member.status !== 'administrator' && member.status !== 'creator')) {
      return sendMsg(chatId, t(lang, 'fj_wizard_bot_not_admin'));
    }
    const oldInviteLink = existingRow?.invite_link;
    const linkParams = { chat_id: chId, creates_join_request: false };
    if (targetLimit > 0) {
      linkParams.member_limit = targetLimit;
    }
    const linkObj = await tgApi.createChatInviteLink(linkParams).catch(() => null);
    if (!linkObj?.invite_link) {
      return sendMsg(chatId, t(lang, 'fj_wizard_create_link_err', { err: 'Link error' }));
    }
    await db.insert(forceChannels).values({
      channel_id: chId,
      channel_name: chName,
      button_text: buttonText || '',
      target_limit: targetLimit || 0,
      invite_link: linkObj.invite_link,
      is_active: true,
      created_at: nowSec(),
    }).onConflictDoUpdate({
      target: forceChannels.channel_id,
      set: {
        channel_name: chName,
        button_text: buttonText || '',
        target_limit: targetLimit || 0,
        invite_link: linkObj.invite_link,
        is_active: true,
      },
    }).run();
    if (oldInviteLink && oldInviteLink !== linkObj.invite_link) {
      await tgApi.revokeChatInviteLink({ chat_id: chId, invite_link: oldInviteLink }).catch(() => {});
    }
    return sendMsg(chatId, t(lang, 'fj_wizard_success', {
      title: escapeHtml(chName),
      btn: escapeHtml(buttonText || chName),
      limit: targetLimit > 0 ? String(targetLimit) : t(lang, 'fj_wizard_unlimited'),
      link: escapeHtml(linkObj.invite_link)
    }));
  }
  if (cmd === '/delchannel') {
    if (!arg) return sendMsg(chatId, t(lang, 'fj_delchannel_usage'));
    const chId = arg.trim();
    const ch = await db.select().from(forceChannels).where(eq(forceChannels.channel_id, chId)).get();
    if (ch?.invite_link) {
      await tgApi.revokeChatInviteLink({ chat_id: ch.channel_id, invite_link: ch.invite_link }).catch(() => {});
    }
    await db.delete(forceChannels).where(eq(forceChannels.channel_id, chId)).run();
    return sendMsg(chatId, t(lang, 'fj_delchannel_success'));
  }
  if (cmd === '/setchannelbtn') {
    const parts = arg.split(/\s+/), chId = parts[0], btnText = parts.slice(1).join(' ');
    if (!chId || !btnText) return sendMsg(chatId, t(lang, 'fj_setchannelbtn_usage'));
    await db.update(forceChannels).set({ button_text: btnText }).where(eq(forceChannels.channel_id, chId)).run();
    return sendMsg(chatId, t(lang, 'fj_label_updated', { name: escapeHtml(btnText) }));
  }
  if (cmd === '/setverifybtn') {
    if (!arg) return sendMsg(chatId, t(lang, 'fj_wizard_setverify_usage'));
    await setConfig('fj_verify_btn_text', arg.trim());
    return sendMsg(chatId, t(lang, 'fj_wizard_setverify_success', { text: escapeHtml(arg.trim()) }));
  }
  return false;
}

export async function handleForceJoinPrompt(session, text, userId, chatId, lang) {
  if (session.mode === 'fj_label') {
    await clearAdminSession(userId);
    const label = (text || '').trim();
    if (label.length < 2 || label.length > 40) {
      return sendMsg(chatId, t(lang, 'fj_setchannelbtn_usage'));
    }
    const chId = session.code;
    if (chId) {
      await db.update(forceChannels).set({ button_text: label }).where(eq(forceChannels.channel_id, chId)).run();
    }
    return sendMsg(chatId, t(lang, 'fj_label_updated', { name: escapeHtml(label) }));
  }
  if (session.mode === 'fj_renew_limit') {
    const input = (text || '').trim();
    if (!/^\d+$/.test(input)) {
      return sendMsg(chatId, t(lang, 'fj_err_invalid_limit'));
    }
    const newLimit = Number(input);
    if (!Number.isInteger(newLimit) || newLimit < 0 || newLimit > 99999) {
      return sendMsg(chatId, t(lang, 'fj_err_invalid_limit'));
    }
    const chId = session.code;
    const ch = await db.select().from(forceChannels).where(eq(forceChannels.channel_id, chId)).get();
    if (!ch) {
      await clearAdminSession(userId);
      return renderForceJoinAdminPanel(chatId, null, lang, false);
    }
    const oldInviteLink = ch.invite_link;
    const linkParams = { chat_id: chId, creates_join_request: false };
    if (newLimit > 0) {
      linkParams.member_limit = newLimit;
    }
    const linkObj = await tgApi.createChatInviteLink(linkParams).catch(() => null);
    if (!linkObj?.invite_link) {
      await clearAdminSession(userId);
      return sendMsg(chatId, t(lang, 'fj_wizard_create_link_err', { err: 'Link error' }));
    }
    await db.update(forceChannels).set({
      invite_link: linkObj.invite_link,
      target_limit: newLimit,
      is_active: true,
    }).where(eq(forceChannels.channel_id, chId)).run();
    if (oldInviteLink && oldInviteLink !== linkObj.invite_link) {
      await tgApi.revokeChatInviteLink({ chat_id: chId, invite_link: oldInviteLink }).catch(() => {});
    }
    await clearAdminSession(userId);
    await sendMsg(chatId, t(lang, 'fj_renew_success', {
      limit: newLimit > 0 ? String(newLimit) : t(lang, 'fj_wizard_unlimited'),
      link: escapeHtml(linkObj.invite_link)
    }));
    return renderForceJoinAdminPanel(chatId, null, lang, false);
  }
  await clearAdminSession(userId);
  return false;
}

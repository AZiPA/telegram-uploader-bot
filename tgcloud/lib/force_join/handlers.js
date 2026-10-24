import {
  db, eq,
  forceChannels,
  tgApi, escapeHtml, ACTIONS,
  sendMsg, answerCq, setAdminPrompt
} from '../helpers.js';
import { renderForceJoinAdminPanel } from './panel.js';
import { t } from '../locales/index.js';

export async function handleChatMember(payload, isMyChatMember = false) {
  const isMy = isMyChatMember || Boolean(payload?.my_chat_member);
  const chatMember = payload?.my_chat_member || payload?.chat_member || payload;
  const chId = chatMember?.chat?.id ? String(chatMember.chat.id) : null;
  if (!chId) return false;

  // Only deactivate on my_chat_member status 'kicked' or 'left', never on regular user chat_member leaves!
  if (isMy) {
    const newStatus = chatMember?.new_chat_member?.status;
    if (newStatus === 'kicked' || newStatus === 'left') {
      await db.update(forceChannels).set({ is_active: false }).where(eq(forceChannels.channel_id, chId)).run();
      return true;
    }
  }

  const inviteLink = chatMember.invite_link;
  if (!inviteLink) return false;

  const isSaturated = Boolean(
    inviteLink.is_revoked ||
    (inviteLink.member_limit && inviteLink.member_limit > 0 && inviteLink.is_revoked)
  );

  if (isSaturated) {
    await db.update(forceChannels).set({ is_active: false }).where(eq(forceChannels.channel_id, chId)).run();
    return true;
  }
  return false;
}

export async function handleForceJoinCallback(data, cq, userId, chatId, messageId, lang, role, ctx) {
  if (data === ACTIONS.FJ_MENU_REFRESH) {
    await answerCq(cq);
    return renderForceJoinAdminPanel(chatId, messageId, lang, true);
  }
  if (data.startsWith(ACTIONS.FJ_STATS)) {
    const chId = data.slice(ACTIONS.FJ_STATS.length);
    const ch = await db.select().from(forceChannels).where(eq(forceChannels.channel_id, chId)).get();
    await answerCq(cq);
    if (ch) {
      return sendMsg(chatId, t(lang, 'fj_audit_body', {
        name: escapeHtml(ch.channel_name),
        limit: ch.target_limit ? String(ch.target_limit) : t(lang, 'fj_wizard_unlimited'),
        status: ch.is_active ? t(lang, 'fj_audit_status_active') : t(lang, 'fj_audit_status_inactive'),
        link: escapeHtml(ch.invite_link)
      }));
    }
    return true;
  }
  if (data.startsWith(ACTIONS.FJ_DELETE)) {
    await answerCq(cq);
    const chId = data.slice(ACTIONS.FJ_DELETE.length);
    const ch = await db.select().from(forceChannels).where(eq(forceChannels.channel_id, chId)).get();
    if (ch?.invite_link) {
      await tgApi.revokeChatInviteLink({ chat_id: ch.channel_id, invite_link: ch.invite_link }).catch(() => {});
    }
    await db.delete(forceChannels).where(eq(forceChannels.channel_id, chId)).run();
    return renderForceJoinAdminPanel(chatId, messageId, lang, true);
  }
  if (data.startsWith(ACTIONS.FJ_RECHECK)) {
    const chId = data.slice(ACTIONS.FJ_RECHECK.length);
    const ch = await db.select().from(forceChannels).where(eq(forceChannels.channel_id, chId)).get();
    if (!ch) return answerCq(cq, 'Channel not found', true);
    try {
      const me = await tgApi.getMe({});
      const m = await tgApi.getChatMember({ chat_id: chId, user_id: me.id }).catch(() => null);
      const ok = Boolean(m && (m.status === 'administrator' || m.status === 'creator'));
      if (!ok) {
        await db.update(forceChannels).set({ is_active: false }).where(eq(forceChannels.channel_id, chId)).run();
        return answerCq(cq, t(lang, 'fj_recheck_not_admin'));
      }
      await db.update(forceChannels).set({ is_active: true }).where(eq(forceChannels.channel_id, chId)).run();
      return answerCq(cq, t(lang, 'fj_channel_reactivated'));
    } catch (err) {
      return answerCq(cq, t(lang, 'fj_recheck_error', { err: String(err?.message || err) }), true);
    }
  }
  if (data.startsWith(ACTIONS.FJ_RENEW)) {
    const chId = data.slice(ACTIONS.FJ_RENEW.length);
    const ch = await db.select().from(forceChannels).where(eq(forceChannels.channel_id, chId)).get();
    if (!ch) return answerCq(cq, 'Channel not found', true);
    await answerCq(cq);
    return setAdminPrompt(
      chatId,
      userId,
      { code: chId, mode: 'fj_renew_limit', items: '[]' },
      t(lang, 'fj_renew_prompt', { name: escapeHtml(ch.channel_name) }),
      t(lang, 'fj_placeholder_limit')
    );
  }
  if (data.startsWith(ACTIONS.FJ_EDIT_LABEL)) {
    const chId = data.slice(ACTIONS.FJ_EDIT_LABEL.length);
    await answerCq(cq);
    return setAdminPrompt(chatId, userId, { code: chId, mode: 'fj_label', items: '[]' }, t(lang, 'fj_label_prompt', { name: escapeHtml(chId) }), t(lang, 'fj_placeholder_label'));
  }
  return false;
}

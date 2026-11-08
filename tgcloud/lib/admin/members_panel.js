import {
  db, eq, desc, count,
  vips, getRoleLevel, getEffectiveOwnerId, ACTIONS,
  nowSec, escapeHtml, truncateText
} from '../helpers.js';
import { t } from '../locales/index.js';
import { sendMsg, editMsg, editMarkup, setAdminPrompt, answerCq } from '../helpers.js';
import { removeAdmin, getAdmins, invalidateAdminsCache, invalidateVipsCache } from './members.js';

export function buildAdminsKeyboard(lang, admins = [], callerRoleOrLevel = 0, ownerId = null) {
  const callerLevel = typeof callerRoleOrLevel === 'number'
    ? callerRoleOrLevel
    : (typeof callerRoleOrLevel === 'boolean'
      ? (callerRoleOrLevel ? 4 : 2)
      : getRoleLevel(callerRoleOrLevel));
  const rows = [];
  for (const adm of admins) {
    const adminId = adm.user_id ?? adm.id;
    const roleLabel = adm.role || 'admin';
    const isOwner = roleLabel === 'owner' || (ownerId != null && (Number(adminId) === Number(ownerId) || String(adminId) === String(ownerId)));
    if (isOwner) {
      const nameOrId = adm.first_name || adm.username || adm.name || adminId;
      rows.push([{ text: `👑 Owner: ${nameOrId}`, callback_data: ACTIONS.NOOP || 'noop' }]);
    } else if (callerLevel >= 3) {
      const targetLevel = getRoleLevel(roleLabel);
      if (callerLevel > targetLevel) {
        rows.push([{
          text: t(lang, 'admins_btn_remove', { role: roleLabel, id: String(adminId) }),
          callback_data: `${ACTIONS.ADMIN_DEL}${adminId}`,
          style: 'danger'
        }]);
      }
    }
  }
  const bottomRow = [];
  if (callerLevel >= 3) {
    bottomRow.push({ text: t(lang, 'admins_btn_add'), callback_data: ACTIONS.ADMIN_ADD_PROMPT, style: 'success' });
  }
  bottomRow.push({ text: t(lang, 'admins_btn_refresh'), callback_data: ACTIONS.ADMIN_REFRESH });
  rows.push(bottomRow);
  return { inline_keyboard: rows };
}

export function buildVipsKeyboard(lang, opts = {}) {
  if (opts.confirmClear) {
    return {
      inline_keyboard: [[
        { text: t(lang, 'btn_vips_confirm_yes'), callback_data: ACTIONS.VIP_CLEAR_YES, style: 'danger' },
        { text: t(lang, 'btn_vips_confirm_no'), callback_data: ACTIONS.VIP_CLEAR_NO }
      ]]
    };
  }
  return {
    inline_keyboard: [[
      { text: t(lang, 'admins_btn_refresh'), callback_data: ACTIONS.VIP_REFRESH },
      { text: t(lang, 'btn_vips_clear_all'), callback_data: ACTIONS.VIP_CLEAR_ASK, style: 'danger' }
    ]]
  };
}

export async function renderAdminsPanel({ chatId, messageId = null, lang, role }) {
  const adminList = await getAdmins();
  const list = [...adminList].sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
  const ownerId = await getEffectiveOwnerId();
  const callerLevel = getRoleLevel(role);
  const markup = buildAdminsKeyboard(lang, list, callerLevel, ownerId);
  const text = t(lang, 'admins_list_title');
  if (messageId) {
    return editMsg(chatId, messageId, text, { reply_markup: markup });
  }
  return sendMsg(chatId, text, { reply_markup: markup });
}

export async function renderVipsPanel({ chatId, messageId = null, lang, opts = {} }) {
  const now = nowSec();
  const allVips = await db.select().from(vips).orderBy(desc(vips.created_at)).all();
  const activeVips = allVips.filter(v => Number(v.expires_at || 0) === 0 || Number(v.expires_at) > now);

  let text;
  if (!activeVips.length) {
    text = t(lang, 'vips_empty');
  } else {
    const lines = activeVips.slice(0, 25).map(v => {
      const id = v.user_id ?? v.id;
      let status;
      if (!v.expires_at || Number(v.expires_at) === 0) {
        status = t(lang, 'vip_lifetime');
      } else {
        const days = Math.max(1, Math.ceil((Number(v.expires_at) - now) / 86400));
        const dateStr = new Date(Number(v.expires_at) * 1000).toISOString().slice(0, 10);
        status = `${t(lang, 'vip_days', { days })} (${dateStr})`;
      }
      return `• <code>${escapeHtml(String(id))}</code> — ${status}`;
    });
    text = `${t(lang, 'vips_list_title', { count: activeVips.length })}\n\n${lines.join('\n')}`;
  }

  const truncated = truncateText(text, 4096);
  const markup = buildVipsKeyboard(lang, opts);
  if (messageId) {
    return editMsg(chatId, messageId, truncated, { reply_markup: markup });
  }
  return sendMsg(chatId, truncated, { reply_markup: markup });
}

export async function handleMembersCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data === ACTIONS.ADMIN_REFRESH) {
    await answerCq(cq);
    invalidateAdminsCache();
    return renderAdminsPanel({ chatId, messageId, lang, role });
  }

  if (data === ACTIONS.ADMIN_MENU) {
    await answerCq(cq);
    return renderAdminsPanel({ chatId, messageId, lang, role });
  }

  if (data === ACTIONS.ADMIN_ADD_PROMPT) {
    await answerCq(cq);
    await setAdminPrompt(userId, 'admin', 'add_admin');
    return sendMsg(chatId, t(lang, 'admin_prompt_add'), {
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: t(lang, 'admin_placeholder_add'),
      },
    });
  }

  if (data.startsWith(ACTIONS.ADMIN_DEL)) {
    await answerCq(cq);
    const callerLevel = getRoleLevel(role);
    const targetId = Number(data.slice(ACTIONS.ADMIN_DEL.length));
    const ownerId = await getEffectiveOwnerId();
    if (callerLevel >= 3 && targetId && targetId !== ownerId) {
      const adminList = await getAdmins();
      const target = adminList?.find((a) => Number(a.user_id) === targetId);
      if (target && target.role !== 'owner') {
        const targetLevel = getRoleLevel(target.role);
        if (callerLevel > targetLevel) {
          await removeAdmin(targetId);
        }
      }
    }
    return renderAdminsPanel({ chatId, messageId, lang, role });
  }

  if (data === ACTIONS.VIP_REFRESH || data === ACTIONS.VIP_CLEAR_NO) {
    await answerCq(cq);
    return renderVipsPanel({ chatId, messageId, lang });
  }

  if (data === ACTIONS.VIP_CLEAR_ASK) {
    await answerCq(cq);
    const callerLevel = getRoleLevel(role);
    if (callerLevel < 3) return answerCq(cq, t(lang, 'superadmin_only_command'), true);
    return editMarkup(chatId, messageId, buildVipsKeyboard(lang, { confirmClear: true }));
  }

  if (data === ACTIONS.VIP_CLEAR_YES) {
    await answerCq(cq);
    const callerLevel = getRoleLevel(role);
    if (callerLevel < 3) return answerCq(cq, t(lang, 'superadmin_only_command'), true);
    const countRes = (await db.select({ c: count() }).from(vips).get())?.c || 0;
    await db.delete(vips).run();
    invalidateVipsCache();
    return editMsg(chatId, messageId, t(lang, 'vips_cleared_all', { count: countRes }), {
      reply_markup: buildVipsKeyboard(lang),
    });
  }

  return false;
}

import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { adminSessions } from '../../schema.js';
import {
  ACTIONS, LIMITS, getBotUsername, escapeHtml, truncateText,
  sendMsg, editMsg, parseItems, nowSec, getBundle, answerCq
} from '../helpers.js';
import { t } from '../locales/index.js';
import { getManagedBundle } from './permissions.js';
import { e, btnIcon, isPremiumEmojiEnabled, applyEmojis } from '../shared/emojis.js';

export function buildBundleHubKeyboard(lang, code, opts = {}) {
  const isPremium = Boolean(opts.isPremium);
  const btn = (text, callback_data, iconName = undefined, style = undefined) => {
    const b = { text, callback_data };
    if (style) b.style = style;
    if (isPremium && iconName) {
      const iconId = btnIcon(iconName, isPremium);
      if (iconId) b.icon_custom_emoji_id = iconId;
    }
    return b;
  };

  return {
    inline_keyboard: [
      [
        btn(
          t(lang, opts.isProtected ? 'btn_settings_protect_on' : 'btn_settings_protect_off'),
          `${ACTIONS.MAKE_PROTECTED}${code}`,
          'settings',
          opts.isProtected ? 'success' : undefined
        ),
        btn(t(lang, opts.isOwnerLocked ? 'hub_btn_unlock_owner' : 'hub_btn_lock_owner'), `${ACTIONS.LOCK_BUNDLE}${code}`, opts.isOwnerLocked ? 'unlocked' : 'lock')
      ],
      [
        btn(t(lang, 'hub_btn_expiry', { val: opts.expiryLabel || t(lang, 'label_disabled') }), `${ACTIONS.BUNDLE_EXPIRY}${code}`, 'settings'),
        btn(t(lang, opts.isOneTime ? 'hub_btn_onetime_on' : 'hub_btn_onetime_off'), `${ACTIONS.BUNDLE_ONETIME}${code}`, 'bundle')
      ],
      [
        btn(t(lang, 'hub_btn_post_channel'), `${ACTIONS.BUNDLE_POST_CHANNEL}${code}`, 'settings')
      ],
      [
        btn(t(lang, 'hub_btn_rotate_now'), `${ACTIONS.BUNDLE_ROTATE_NOW}${code}`, 'settings'),
        btn(t(lang, 'hub_btn_rotate_interval', { val: opts.rotateIntLabel || t(lang, 'label_disabled') }), `${ACTIONS.BUNDLE_ROTATE_INT}${code}`, 'settings')
      ],
      [
        btn(t(lang, 'hub_btn_review'), `mng:review:${code}`, 'search'),
        btn(t(lang, 'hub_btn_test_dl'), `mng:testdl:${code}`, 'download')
      ],
      [btn(t(lang, 'hub_btn_delete_bundle'), `${ACTIONS.DELETE_CONFIRM_ASK}${code}`, 'danger', 'danger')]
    ]
  };
}

export const buildHubKeyboard = buildBundleHubKeyboard;

export function formatBundleItemList(items, isPremium = false, max = 5) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const folderIcon = e('folder', isPremium);
  const bundleIcon = e('bundle', isPremium);
  const rows = items.slice(0, max).map((item, idx) => {
    const icon = item.type === 'document' ? folderIcon : bundleIcon;
    const name = escapeHtml(item.file_name || item.caption || `item_${idx + 1}`);
    return `  ${icon} <code>#${idx + 1}</code> ${name}`;
  });
  if (items.length > max) {
    rows.push(`  … (+${items.length - max})`);
  }
  return rows.join('\n') + '\n';
}

export async function renderHub(chatId, messageId, code, lang, role, userId, edit = false) {
  if (typeof messageId === 'string') {
    const legacyCode = messageId;
    const legacyLang = code;
    const legacyEditId = lang;
    code = legacyCode;
    lang = legacyLang;
    messageId = legacyEditId || null;
    edit = Boolean(messageId);
  }
  const isPremium = await isPremiumEmojiEnabled(db);
  const row = await getBundle(code);
  if (!row) return sendMsg(chatId, t(lang, 'bundle_not_found'));
  const items = parseItems(row.items);
  const now = nowSec();
  const expiryLabel = (row.expires_at > 0 && row.expires_at > now) ? `${Math.ceil((row.expires_at - now) / 3600)}h` : t(lang, 'label_disabled');
  const botUsername = await getBotUsername();
  const shareLink = `https://t.me/${botUsername}?start=${escapeHtml(row.code)}`;

  let header = t(lang, 'hub_title');
  if (isPremium) {
    header = header.replace('🎛', '⚙️');
  }

  let text = header +
    t(lang, 'hub_code', { code: escapeHtml(row.code) }) +
    t(lang, 'hub_status', { status: row.protect_content ? t(lang, 'hub_status_protected') : t(lang, 'hub_status_public') }) +
    t(lang, 'hub_owner_locked', { status: row.owner_locked ? t(lang, 'status_active_red') : t(lang, 'status_inactive_green') }) +
    t(lang, 'hub_expires_at', { time: expiryLabel }) +
    t(lang, 'hub_is_one_time', { status: row.is_one_time ? t(lang, 'status_active_red') : t(lang, 'status_inactive_green') }) +
    (row.post_channel_id ? t(lang, 'hub_channel_post', { channel: escapeHtml(row.post_channel_id), interval: row.rotate_interval_sec ? `${row.rotate_interval_sec / 3600}h` : t(lang, 'label_disabled') }) : '') +
    t(lang, 'hub_search_name', { title: row.title ? escapeHtml(row.title) : t(lang, 'hub_search_none') }) +
    t(lang, 'hub_files_count', { total: items.length, max: LIMITS.MAX_BUNDLE_ITEMS });

  if (items.length > 0) {
    text += formatBundleItemList(items, false, 5);
  }

  text += t(lang, 'hub_share_link', { link: shareLink });
  text = applyEmojis(text, isPremium);

  const kb = buildBundleHubKeyboard(lang, row.code, {
    isProtected: Boolean(row.protect_content),
    isOwnerLocked: Boolean(row.owner_locked),
    expiryLabel,
    isOneTime: Boolean(row.is_one_time),
    rotateIntLabel: row.rotate_interval_sec ? `${row.rotate_interval_sec / 3600}h` : undefined,
    isPremium,
  });
  const truncated = truncateText(text, 4096);
  if (edit && messageId) {
    return editMsg(chatId, messageId, truncated, kb, true);
  }
  return sendMsg(chatId, truncated, kb);
}

export async function handleHubCommand(cmd, arg, chatId, userId, lang, role) {
  if (cmd === '/edit' || cmd === '/manage') {
    if (!arg) return sendMsg(chatId, t(lang, 'review_usage'));
    const code = arg.replace(/^(?:https?:\/\/)?t\.me\/[a-zA-Z0-9_]+\?start=/, '').split('_')[0];
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (!row) return sendMsg(chatId, t(lang, 'bundle_not_found'));
    if (!allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    const now = nowSec();
    const serializedItems = typeof row.items === 'string' ? row.items : JSON.stringify(row.items || []);
    await db.insert(adminSessions).values({
      admin_id: Number(userId),
      code,
      mode: 'edit',
      items: serializedItems,
      updated_at: now,
    }).onConflictDoUpdate({
      target: adminSessions.admin_id,
      set: {
        code,
        mode: 'edit',
        items: serializedItems,
        updated_at: now,
      },
    }).run();
    return renderHub(chatId, null, code, lang, role, userId, false);
  }
}

export async function handleHubCallback(data, cq, userId, chatId, messageId, lang, role) {
  if (data.startsWith(ACTIONS.MANAGE_HUB)) {
    await answerCq(cq);
    const code = data.slice(ACTIONS.MANAGE_HUB.length);
    const { row, allowed } = await getManagedBundle(code, role, userId);
    if (allowed) {
      await db.delete(adminSessions).where(and(eq(adminSessions.admin_id, Number(userId)), eq(adminSessions.mode, 'edit'))).run();
      return renderHub(chatId, messageId, code, lang, role, userId, true);
    }
  }
}

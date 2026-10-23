import { t } from '../locales/index.js';
import { ACTIONS } from '../helpers.js';
import { btnIcon } from './emojis.js';

export function buildInlineButton(textOrObj, callbackData = undefined, iconName = undefined, isPremium = false, style = undefined) {
  let text = textOrObj;
  let cb = callbackData;
  let icon = iconName;
  let prem = isPremium;
  let url = undefined;
  let btnStyle = style;

  if (typeof textOrObj === 'object' && textOrObj !== null) {
    text = textOrObj.text;
    cb = textOrObj.callback_data;
    url = textOrObj.url;
    icon = textOrObj.iconName || textOrObj.icon;
    prem = Boolean(textOrObj.isPremium);
    btnStyle = textOrObj.style ?? btnStyle;
  }

  const btn = { text };
  if (cb !== undefined) btn.callback_data = cb;
  if (url !== undefined) btn.url = url;
  if (btnStyle !== undefined) btn.style = btnStyle;

  if (prem && icon) {
    const iconId = btnIcon(icon, prem);
    if (iconId) {
      btn.icon_custom_emoji_id = iconId;
    }
  }
  return btn;
}

export const createInlineButton = buildInlineButton;

export function buildDeliveryKeyboard(lang, code, opts = {}) {
  const rows = [];
  const isPremium = Boolean(opts.isPremium);
  if (opts.nextOffset != null && opts.remainingCount > 0) {
    rows.push([
      buildInlineButton(
        t(lang, 'delivery_next_part', { count: opts.remainingCount }),
        `${ACTIONS.CHUNK_DELIVERY}${code}:${opts.nextOffset}`,
        opts.iconNext || 'download',
        isPremium
      )
    ]);
  }
  rows.push([
    buildInlineButton(
      t(lang, 'btn_vote_like', { count: opts.likes || 0 }),
      `${ACTIONS.VOTE_LIKE}${code}`,
      opts.iconLike,
      isPremium
    ),
    buildInlineButton(
      t(lang, 'btn_vote_dislike', { count: opts.dislikes || 0 }),
      `${ACTIONS.VOTE_DISLIKE}${code}`,
      opts.iconDislike,
      isPremium
    )
  ]);
  rows.push([
    buildInlineButton(
      t(lang, 'btn_redownload'),
      `${ACTIONS.REDOWNLOAD}${code}`,
      opts.iconRedownload || 'download',
      isPremium
    )
  ]);
  return { inline_keyboard: rows };
}

export const buildPostDeliveryKeyboard = buildDeliveryKeyboard;

export function buildChannelPostKeyboard(lang, botUsername, code, opts = {}) {
  const isPremium = typeof opts === 'boolean' ? opts : Boolean(opts?.isPremium);
  const iconName = typeof opts === 'object' && opts?.iconName ? opts.iconName : 'download';
  const cleanUsername = String(botUsername || '').replace(/^@/, '');
  const btn = buildInlineButton({
    text: t(lang, 'btn_channel_download'),
    url: `https://t.me/${cleanUsername}?start=${code}`,
    iconName,
    isPremium,
  });
  return {
    inline_keyboard: [[btn]]
  };
}

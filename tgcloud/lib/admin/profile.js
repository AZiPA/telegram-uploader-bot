import { InputFile, api as sdkApi } from 'sdk';
import { tgApi, escapeHtml, sendMsg, clearAdminSession, ACTIONS, db as defaultDb } from '../helpers.js';
import { t } from '../locales/index.js';
import { buildProfileKeyboard, buildBotProfileKeyboard, renderBotProfileMenu } from './profile_panel.js';

export async function setBotProfilePhoto(fileId, api = tgApi, mimeType = 'image/jpeg') {
  const client = (api && typeof api.setMyProfilePhoto === 'function') ? api : tgApi;
  let fileData = null;
  const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
  const filename = `profile.${ext}`;

  try {
    if (typeof client.getFileContent === 'function') {
      const bytes = await client.getFileContent(fileId);
      if (bytes) {
        fileData = new InputFile(bytes, filename, { type: mimeType });
      }
    } else if (typeof sdkApi?.getFileContent === 'function') {
      const bytes = await sdkApi.getFileContent(fileId);
      if (bytes) {
        fileData = new InputFile(bytes, filename, { type: mimeType });
      }
    }
  } catch (_) {}

  if (!fileData) {
    try {
      const streamGetter = typeof client.getFileStream === 'function' ? client.getFileStream : sdkApi?.getFileStream;
      if (typeof streamGetter === 'function') {
        const stream = await streamGetter(fileId);
        if (stream && typeof stream.bytes === 'function') {
          const bytes = await stream.bytes();
          if (bytes) {
            fileData = new InputFile(bytes, filename, { type: mimeType });
          }
        }
      }
    } catch (_) {}
  }

  if (!fileData) {
    try {
      const getFileFn = typeof client.getFile === 'function' ? client.getFile : sdkApi?.getFile;
      if (typeof getFileFn === 'function') {
        const res = await getFileFn(fileId);
        if (res instanceof Uint8Array || res instanceof ArrayBuffer) {
          fileData = new InputFile(res, filename, { type: mimeType });
        } else if (res && typeof res.bytes === 'function') {
          const bytes = await res.bytes();
          if (bytes) fileData = new InputFile(bytes, filename, { type: mimeType });
        }
      }
    } catch (_) {}
  }

  const payloads = [];
  if (fileData) {
    payloads.push({ photo: { type: 'static', photo: fileData } });
    payloads.push({ photo: fileData });
  }
  payloads.push({ photo: { type: 'static', photo: fileId } });
  payloads.push({ photo: fileId });

  let lastErr = null;
  for (const payload of payloads) {
    try {
      if (typeof client.setMyProfilePhoto === 'function') {
        return await client.setMyProfilePhoto(payload);
      }
      if (typeof sdkApi?.setMyProfilePhoto === 'function') {
        return await sdkApi.setMyProfilePhoto(payload);
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
}

export async function removeBotProfilePhoto(api = tgApi) {
  const client = (api && typeof api.removeMyProfilePhoto === 'function') ? api : tgApi;
  try {
    if (typeof client.removeMyProfilePhoto === 'function') {
      return await client.removeMyProfilePhoto({});
    }
    if (typeof sdkApi?.removeMyProfilePhoto === 'function') {
      return await sdkApi.removeMyProfilePhoto({});
    }
  } catch (_) {
    if (typeof client.removeMyProfilePhoto === 'function') {
      return await client.removeMyProfilePhoto();
    }
    if (typeof sdkApi?.removeMyProfilePhoto === 'function') {
      return await sdkApi.removeMyProfilePhoto();
    }
  }
}

export async function handleProfilePhoto(message, userId, chatId, lang, api = tgApi, db = defaultDb) {
  let fileId = null;
  let mimeType = 'image/jpeg';

  if (message?.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    const highestPhoto = message.photo[message.photo.length - 1];
    fileId = highestPhoto.file_id;
    mimeType = 'image/jpeg';
  } else if (message?.document && typeof message.document.mime_type === 'string' && message.document.mime_type.startsWith('image/')) {
    fileId = message.document.file_id;
    mimeType = message.document.mime_type;
  }

  if (fileId) {
    try {
      await setBotProfilePhoto(fileId, api, mimeType);
      await clearAdminSession(userId);
      await sendMsg(chatId, t(lang, 'profile_photo_updated'));
      return await renderBotProfileMenu(chatId, null, lang, api, db);
    } catch (err) {
      console.error('Failed to set bot profile photo:', err);
      await clearAdminSession(userId);
      const errMsg = err?.description || err?.message || 'Error';
      await sendMsg(chatId, `❌ <b>Error:</b> <code>${escapeHtml(errMsg)}</code>`);
      return await renderBotProfileMenu(chatId, null, lang, api, db);
    }
  }

  return await sendMsg(chatId, t(lang, 'profile_err_photo_required'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: `❌ ${t(lang, 'profile_btn_cancel')}`, callback_data: ACTIONS.BOT_PROFILE_CANCEL, style: 'danger' }]
      ]
    }
  });
}

export async function handleBotProfileCommand(cmd, arg, message, userId, chatId, lang) {
  if (cmd === '/botprofile') {
    return renderBotProfileMenu(chatId, null, lang);
  }
  return false;
}

export async function handleProfilePrompt(session, text, userId, chatId, lang, api = tgApi) {
  const action = session.action || session.mode;
  if (action === 'bprof_waiting_photo') {
    return await sendMsg(chatId, t(lang, 'profile_err_photo_required'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: `❌ ${t(lang, 'profile_btn_cancel')}`, callback_data: ACTIONS.BOT_PROFILE_CANCEL, style: 'danger' }]
        ]
      }
    });
  }

  await clearAdminSession(userId);
  const client = (api && typeof api.setMyName === 'function') ? api : tgApi;

  if (action === 'bprof_waiting_name' || action === 'profile_name') {
    const name = text.trim();
    if (!name || name.length > 64) {
      await sendMsg(chatId, t(lang, 'profile_name_too_long', { max: 64 }));
      return renderBotProfileMenu(chatId, null, lang);
    }
    try {
      await client.setMyName({ name });
      await sendMsg(chatId, t(lang, 'profile_name_updated', { name: escapeHtml(name) }));
    } catch (err) {
      const errMsg = err?.description || err?.message || 'Error';
      await sendMsg(chatId, `❌ <b>Error:</b> <code>${escapeHtml(errMsg)}</code>`);
    }
    return renderBotProfileMenu(chatId, null, lang);
  }

  if (action === 'bprof_waiting_desc' || action === 'profile_desc') {
    const desc = text.trim();
    if (desc.length > 512) {
      await sendMsg(chatId, t(lang, 'profile_desc_too_long', { max: 512 }));
      return renderBotProfileMenu(chatId, null, lang);
    }
    try {
      await client.setMyDescription({ description: desc });
      await sendMsg(chatId, t(lang, 'profile_desc_updated'));
    } catch (err) {
      const errMsg = err?.description || err?.message || 'Error';
      await sendMsg(chatId, `❌ <b>Error:</b> <code>${escapeHtml(errMsg)}</code>`);
    }
    return renderBotProfileMenu(chatId, null, lang);
  }

  if (action === 'bprof_waiting_short' || action === 'profile_short_desc') {
    const shortDesc = text.trim();
    if (shortDesc.length > 120) {
      await sendMsg(chatId, t(lang, 'profile_short_desc_too_long', { max: 120 }));
      return renderBotProfileMenu(chatId, null, lang);
    }
    try {
      await client.setMyShortDescription({ short_description: shortDesc });
      await sendMsg(chatId, t(lang, 'profile_short_desc_updated'));
    } catch (err) {
      const errMsg = err?.description || err?.message || 'Error';
      await sendMsg(chatId, `❌ <b>Error:</b> <code>${escapeHtml(errMsg)}</code>`);
    }
    return renderBotProfileMenu(chatId, null, lang);
  }

  return false;
}

export { buildProfileKeyboard, buildBotProfileKeyboard, renderBotProfileMenu };

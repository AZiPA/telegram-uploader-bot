import {
  db, eq, and,
  adminSessions, bundles,
  tgApi, getConfig, setConfig, getRoleLevel, getEffectiveOwnerId,
  escapeHtml, generateBase62Code, generateBundleCode, LIMITS,
  sendMsg, clearAdminSession, clearUserSession, parseItems, nowSec, getBotUsername
} from '../helpers.js';
import { getStorageChannelId, copyMediaToStorage } from '../services/storage_channel.js';
import { sendLogAlert } from '../services/log_channel.js';
import { renderHub } from '../bundles/hub_panel.js';
import { t } from '../locales/index.js';
import { extractMediaPayload, getAllowedMediaTypes } from '../services/media_config.js';

export async function handleMediaUpload(message, userId, chatId, lang, role, ctx) {
  const sess = await db.select().from(adminSessions).where(eq(adminSessions.admin_id, Number(userId))).get();
  if (!sess) return;
  const now = nowSec();
  if (['upload', 'batch', 'edit'].includes(sess.mode) && (now - (sess.updated_at || 0) > 600)) {
    await clearAdminSession(userId);
    return sendMsg(chatId, t(lang, 'operation_cancelled'));
  }
  if (getRoleLevel(role) < 2) {
    await clearAdminSession(userId);
    return;
  }

  const payload = extractMediaPayload(message);
  if (!payload) {
    return sendMsg(chatId, t(lang, 'media_type_unsupported'));
  }

  const allowedTypes = await getAllowedMediaTypes(db);
  if (!allowedTypes.includes(payload.mediaType)) {
    return sendMsg(chatId, t(lang, 'media_type_disabled'));
  }

  const itemType = payload.mediaType;
  const sourceMessageId = Number(message.message_id || 0);
  const fallbackUniqueId = `${itemType}_${sourceMessageId}_${Date.now()}`;
  const fileUniqueId = payload.file_unique_id || fallbackUniqueId;

  // Pre-copy validation: Validate limits and duplicates BEFORE copying to storage channel
  if (sess.mode === 'edit') {
    const bundle = await db.select({ items: bundles.items }).from(bundles).where(eq(bundles.code, sess.code)).get();
    if (!bundle) {
      await clearAdminSession(userId);
      return sendMsg(chatId, t(lang, 'bundle_not_found'));
    }
    const items = parseItems(bundle.items);
    if (items.length >= LIMITS.MAX_BUNDLE_ITEMS) {
      return sendMsg(chatId, t(lang, 'upload_batch_limit', { maxSession: LIMITS.MAX_PER_SESSION_UPLOAD, maxTotal: LIMITS.MAX_BUNDLE_ITEMS }));
    }
    const isDuplicate = items.some((it) => {
      if (sourceMessageId > 0 && it.source_message_id === sourceMessageId) return true;
      if (fileUniqueId && it.file_unique_id === fileUniqueId) return true;
      return false;
    });
    if (isDuplicate) {
      return sendMsg(chatId, t(lang, 'file_added_done_hint'));
    }
  } else {
    const items = parseItems(sess.items);
    if (items.length >= LIMITS.MAX_BUNDLE_ITEMS || items.length >= LIMITS.MAX_PER_SESSION_UPLOAD) {
      return sendMsg(chatId, t(lang, 'upload_batch_limit', { maxSession: LIMITS.MAX_PER_SESSION_UPLOAD, maxTotal: LIMITS.MAX_BUNDLE_ITEMS }));
    }
    const isDuplicate = items.some((it) => {
      if (sourceMessageId > 0 && it.source_message_id === sourceMessageId) return true;
      if (fileUniqueId && it.file_unique_id === fileUniqueId) return true;
      return false;
    });
    if (isDuplicate) {
      return sendMsg(chatId, t(lang, 'file_added_done_hint'));
    }
  }

  let storageMessageId = null;
  let activeStorageChannelId = null;
  const storageActive = (await getConfig('storage_channel_active', 'false')) === 'true';
  if (storageActive) {
    const storageChannelId = await getStorageChannelId(db);
    if (storageChannelId) {
      activeStorageChannelId = storageChannelId;
      try {
        const copyRes = await copyMediaToStorage(message, payload, itemType, storageChannelId, tgApi);
        if (copyRes?.message_id) {
          storageMessageId = copyRes.message_id;
        }
      } catch (err) {
        const status = Number(err?.code || err?.status || 0);
        const desc = String(err?.description || err?.message || '');
        const isChannelFatal = status === 403 || (status === 400 && /CHAT_ADMIN_REQUIRED|CHAT_FORWARDS_RESTRICTED|kicked|chat not found/i.test(desc));
        if (isChannelFatal) {
          await setConfig('storage_channel_active', 'false');
        } else {
          console.warn(`[storage_channel] Non-fatal item mirroring error: ${status} ${desc}`);
        }
        storageMessageId = null;
        try {
          await sendLogAlert('🚨 Mirroring Error', `${t(lang, 'storage_mirror_error')}\nChat <code>${escapeHtml(chatId)}</code>: ${escapeHtml(desc)}`, tgApi, db);
        } catch (_) {}
      }
    }
  }

  const newItem = {
    file_id: payload.file_id,
    file_unique_id: fileUniqueId,
    type: itemType,
    file_name: payload.file_name || undefined,
    caption: payload.caption || undefined,
    file_size: payload.file_size || 0,
    storage_message_id: storageMessageId,
    storage_channel_id: activeStorageChannelId,
    source_message_id: sourceMessageId,
  };

  const MAX_CAS_ATTEMPTS = 12;

  if (sess.mode === 'edit') {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const bundle = await db.select({ items: bundles.items }).from(bundles).where(eq(bundles.code, sess.code)).get();
      if (!bundle) break;
      let items = parseItems(bundle.items);
      if (items.length >= LIMITS.MAX_BUNDLE_ITEMS) {
        return sendMsg(chatId, t(lang, 'upload_batch_limit', { maxSession: LIMITS.MAX_PER_SESSION_UPLOAD, maxTotal: LIMITS.MAX_BUNDLE_ITEMS }));
      }
      const isDuplicate = items.some((it) => {
        if (sourceMessageId > 0 && it.source_message_id === sourceMessageId) return true;
        if (newItem.file_unique_id && it.file_unique_id === newItem.file_unique_id) return true;
        return false;
      });
      if (isDuplicate) {
        return sendMsg(chatId, t(lang, 'file_added_done_hint'));
      }
      const updatedItems = [...items, newItem];
      updatedItems.sort((a, b) => {
        const sA = Number(a.source_message_id || 0);
        const sB = Number(b.source_message_id || 0);
        if (sA > 0 && sB > 0) return sA - sB;
        return 0;
      });
      const casRes = await db.update(bundles)
        .set({ items: updatedItems })
        .where(and(eq(bundles.code, sess.code), eq(bundles.items, bundle.items)))
        .run();
      const affected = casRes?.rowsAffected ?? 0;
      if (affected === 1) {
        await db.update(adminSessions)
          .set({ items: updatedItems, updated_at: nowSec() })
          .where(eq(adminSessions.admin_id, Number(userId)))
          .run();
        return sendMsg(chatId, t(lang, 'file_added_done_hint'));
      }
    }
    return sendMsg(chatId, t(lang, 'bundle_save_error'));
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const freshSess = await db.select().from(adminSessions).where(eq(adminSessions.admin_id, Number(userId))).get();
    if (!freshSess) {
      return sendMsg(chatId, t(lang, 'operation_cancelled'));
    }
    let items = parseItems(freshSess.items);
    if (items.length >= LIMITS.MAX_BUNDLE_ITEMS || items.length >= LIMITS.MAX_PER_SESSION_UPLOAD) {
      return sendMsg(chatId, t(lang, 'upload_batch_limit', { maxSession: LIMITS.MAX_PER_SESSION_UPLOAD, maxTotal: LIMITS.MAX_BUNDLE_ITEMS }));
    }
    const isDuplicate = items.some((it) => {
      if (sourceMessageId > 0 && it.source_message_id === sourceMessageId) return true;
      if (newItem.file_unique_id && it.file_unique_id === newItem.file_unique_id) return true;
      return false;
    });
    if (isDuplicate) {
      return sendMsg(chatId, t(lang, 'file_added_done_hint'));
    }
    const updatedItems = [...items, newItem];
    updatedItems.sort((a, b) => {
      const sA = Number(a.source_message_id || 0);
      const sB = Number(b.source_message_id || 0);
      if (sA > 0 && sB > 0) return sA - sB;
      return 0;
    });

    if (freshSess.mode === 'upload') {
      const ttlHours = Number(await getConfig('bundle_ttl_hours', '0')) || 0;
      const expiresAt = ttlHours > 0 ? now + ttlHours * 3600 : 0;
      const defaultProtect = (await getConfig('default_protect_content', '0')) === '1';
      const isProtected = defaultProtect;

      let bundleCode = '';
      let inserted = false;
      let attempts = 0;

      while (!inserted && attempts < 3) {
        attempts++;
        bundleCode = generateBundleCode(isProtected);
        try {
          await db.insert(bundles).values({
            code: bundleCode,
            title: null,
            items: updatedItems,
            protect_content: isProtected,
            expires_at: expiresAt,
            created_by: Number(userId),
            created_at: now,
          }).run();
          inserted = true;
        } catch (err) {
          const msg = String(err?.message || err?.description || err || '');
          if (msg.includes('UNIQUE') || msg.includes('constraint')) {
            continue;
          }
          throw err;
        }
      }

      if (!inserted) {
        throw new Error('Failed to allocate unique bundle code after 3 attempts');
      }

      await db.delete(adminSessions)
        .where(eq(adminSessions.admin_id, Number(userId)))
        .run()
        .catch(() => {});

      const botUsername = await getBotUsername();
      return sendMsg(chatId, t(lang, 'upload_single_success', { link: `https://t.me/${botUsername}?start=${bundleCode}` }));
    }

    const casRes = await db.update(adminSessions)
      .set({ items: updatedItems, updated_at: nowSec() })
      .where(and(eq(adminSessions.admin_id, Number(userId)), eq(adminSessions.items, freshSess.items)))
      .run();
    const affected = casRes?.rowsAffected ?? 0;
    if (affected === 1) {
      return sendMsg(chatId, t(lang, 'file_added_done_hint'));
    }
  }
  return sendMsg(chatId, t(lang, 'bundle_save_error'));
}

export async function handleUploadCommand(cmd, arg, message, userId, chatId, lang, role, ctx) {
  userId = userId || message?.from?.id;
  chatId = chatId || message?.chat?.id;
  lang = lang || 'en';
  const now = nowSec();

  if (cmd === '/upload' || cmd === '/batch') {
    const ownerId = await getEffectiveOwnerId();
    if (!ownerId || ownerId === 0) {
      return sendMsg(chatId, t(lang, 'bot_uninitialized'));
    }
    const sessionMode = cmd.slice(1);
    await db.insert(adminSessions).values({
      admin_id: Number(userId),
      code: '',
      mode: sessionMode,
      items: '[]',
      updated_at: now,
    }).onConflictDoUpdate({
      target: adminSessions.admin_id,
      set: {
        code: '',
        mode: sessionMode,
        items: '[]',
        updated_at: now,
      },
    }).run();
    const text = cmd === '/upload'
      ? t(lang, 'upload_single_mode')
      : t(lang, 'upload_batch_mode', { max: LIMITS.MAX_PER_SESSION_UPLOAD });
    return sendMsg(chatId, text);
  }

  if (cmd === '/cancel') {
    await clearAdminSession(userId);
    await clearUserSession(userId);
    return sendMsg(chatId, t(lang, 'operation_cancelled'));
  }

  if (cmd === '/done') {
    const s = await db.select().from(adminSessions).where(eq(adminSessions.admin_id, Number(userId))).get();
    if (s && ['upload', 'batch', 'edit'].includes(s.mode) && (now - (s.updated_at || 0) > 600)) {
      await clearAdminSession(userId);
      return sendMsg(chatId, t(lang, 'operation_cancelled'));
    }
    if (s && s.mode !== 'edit') {
      let items = parseItems(s.items);
      if (items.length > 0) {
        items.sort((a, b) => {
          const sA = Number(a.source_message_id || 0);
          const sB = Number(b.source_message_id || 0);
          if (sA > 0 && sB > 0) return sA - sB;
          return 0;
        });

        const ttlHours = Number(await getConfig('bundle_ttl_hours', '0')) || 0;
        const expiresAt = ttlHours > 0 ? now + ttlHours * 3600 : 0;
        const defaultProtect = (await getConfig('default_protect_content', '0')) === '1';
        const isProtected = defaultProtect;

        let bundleCode = '';
        let inserted = false;
        let attempts = 0;

        while (!inserted && attempts < 3) {
          attempts++;
          bundleCode = generateBundleCode(isProtected);
          try {
            await db.insert(bundles).values({
              code: bundleCode,
              title: null,
              items,
              protect_content: isProtected,
              expires_at: expiresAt,
              created_by: Number(userId),
              created_at: now,
            }).run();
            inserted = true;
          } catch (err) {
            const msg = String(err?.message || err?.description || err || '');
            if (msg.includes('UNIQUE') || msg.includes('constraint')) {
              continue;
            }
            throw err;
          }
        }

        if (!inserted) {
          throw new Error('Failed to allocate unique bundle code after 3 attempts');
        }

        await db.delete(adminSessions)
          .where(eq(adminSessions.admin_id, Number(userId)))
          .run()
          .catch(() => {});

        return renderHub(chatId, bundleCode, lang);
      }
    }
    if (s) {
      await clearAdminSession(userId);
      return renderHub(chatId, s.code, lang);
    }
    return true;
  }

  return false;
}

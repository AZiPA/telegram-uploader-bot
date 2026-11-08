import { db } from 'sdk';
import { eq } from 'sdk/db';
import { uploadSessions, bundles } from '../../schema.js';
import {
  getRoleLevel, getEffectiveOwnerId, LIMITS,
  sendMsg, clearAdminSession, clearUserSession, getAdminSession, nowSec, getBotUsername,
} from '../helpers.js';
import { renderHub } from '../bundles/hub_panel.js';
import { t } from '../locales/index.js';
import { extractMediaPayload, getAllowedMediaTypes } from '../services/media_config.js';
import { getFreshAdminRole, getManagedBundleFresh } from '../bundles/permissions.js';
import {
  captureUploadSession, startUploadOperation, getUploadOperation, findUpdateReceipt, claimUploadItem,
  acceptUploadItem, sealUploadSession, completeUploadSession, markUploadReceipt, hasAcceptedUploadReceipt,
} from './upload_state.js';
import { mirrorAcceptedItem, projectMirrorReceipts } from './upload_mirror.js';
import { clearExpiredAdminSession } from '../shared/sessions.js';
import { uploadSessionExpired } from './upload_state.js';
import { linkUpdateOperation, markUpdateDispatch } from '../core/update_ledger.js';

async function optionalProjection(sessionId, userId, lang) {
  try { await projectMirrorReceipts(sessionId); } catch (error) {
    console.warn('Optional mirror receipt projection deferred:', error?.message || error);
    try {
      await sendMsg(userId, t(lang, 'storage_mirror_receipt_warning'), null, { protect_content: true });
    } catch (_) {}
  }
}

async function optionalMirror(receipt, message, userId, chatId, lang) {
  try { await mirrorAcceptedItem(receipt, message, userId, chatId, lang); } catch (error) {
    console.warn('Optional mirror deferred:', error?.message || error);
    try { await sendMsg(userId, t(lang, 'storage_mirror_warning'), null, { protect_content: true }); } catch (_) {}
  }
}

async function reportBundle(bundle, chatId, lang, single) {
  if (!bundle) return sendMsg(chatId, t(lang, 'operation_cancelled'));
  if (!single) return renderHub(chatId, bundle.code, lang);
  const botUsername = await getBotUsername();
  return sendMsg(chatId, t(lang, 'upload_single_success', { link: `https://t.me/${botUsername}?start=${bundle.code}` }));
}

async function replayUpload(receipt, chatId, lang, message = null) {
  if (receipt.state === 'rejected') return sendMsg(chatId, t(lang, 'operation_cancelled'));
  const op = await db.select().from(uploadSessions).where(eq(uploadSessions.id, receipt.session_id)).get();
  if (!op) return sendMsg(chatId, t(lang, 'operation_cancelled'));
  if (op.state === 'deleted') {
    await completeUploadSession(op.id);
    return sendMsg(chatId, t(lang, 'operation_cancelled'));
  }
  const included = receipt.kind === 'done' || receipt.state === 'accepted' || receipt.state === 'duplicate'
    || op.items.some((item) => item.item_id === receipt.id);
  let acceptedEdit = false;
  if (op.mode === 'edit') {
    const target = op.bundle_id ? await db.select().from(bundles).where(eq(bundles.upload_session_id, op.bundle_id)).get() : null;
    if (!target) return sendMsg(chatId, t(lang, 'operation_cancelled'));
    const managed = await getManagedBundleFresh(target.code, receipt.admin_id);
    if (!managed.allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    const bundle = managed.row;
    if (bundle.upload_session_id !== op.bundle_id) return sendMsg(chatId, t(lang, 'operation_cancelled'));
    if (receipt.kind === 'done') {
      await markUploadReceipt(receipt, 'accepted');
      await optionalProjection(op.id, receipt.admin_id, lang);
      const pointer = await getAdminSession(receipt.admin_id);
      if (pointer?.session_id === op.id && pointer.generation === op.generation) {
        await clearAdminSession(receipt.admin_id, pointer);
      }
      return reportBundle(bundle, chatId, lang, false);
    }
    acceptedEdit = bundle.items.some((item) => item.item_id === receipt.id)
      || (bundle.removed_item_ids || []).includes(receipt.id);
  }
  if (!included && !acceptedEdit) {
    await markUploadReceipt(receipt, 'rejected');
    return sendMsg(chatId, t(lang, 'operation_cancelled'));
  }
  if (receipt.kind === 'item' && receipt.state !== 'accepted' && receipt.state !== 'duplicate') {
    await markUploadReceipt(receipt, 'accepted');
  }
  if (['finalizing', 'complete'].includes(op.state)) {
    const bundle = await completeUploadSession(op.id);
    if (message && receipt.kind === 'item') await optionalMirror(receipt, message, receipt.admin_id, chatId, lang);
    await optionalProjection(op.id, receipt.admin_id, lang);
    return reportBundle(bundle, chatId, lang, op.mode === 'upload');
  }
  if (message && receipt.kind === 'item') await optionalMirror(receipt, message, receipt.admin_id, chatId, lang);
  await optionalProjection(op.id, receipt.admin_id, lang);
  return sendMsg(chatId, t(lang, receipt.kind === 'done' ? 'bundle_save_error' : 'file_added_done_hint'));
}

export async function handleMediaUpload(message, userId, chatId, lang, role, ctx) {
  role = await getFreshAdminRole(userId);
  if (getRoleLevel(role) < 2) return;
  const replay = await findUpdateReceipt(userId, ctx);
  if (replay) await linkUpdateOperation(ctx, 'upload', replay.session_id);
  if (replay && (replay.state === 'rejected' || await hasAcceptedUploadReceipt(replay))) {
    return replayUpload(replay, chatId, lang, message);
  }
  const session = await captureUploadSession(userId);
  if (replay && (!session || replay.session_id !== session.session_id || session.state !== 'active')) {
    return replayUpload(replay, chatId, lang, message);
  }
  if (!session) return;
  await linkUpdateOperation(ctx, 'upload', session.session_id);
  await markUpdateDispatch(ctx);
  if (await uploadSessionExpired(session)) {
    const expired = await clearExpiredAdminSession(session, nowSec() - 600);
    if (expired.rowsAffected === 1) {
    return sendMsg(chatId, t(lang, 'operation_cancelled'));
    }
  }
  if (session.state !== 'active') return sendMsg(chatId, t(lang, 'operation_cancelled'));
  const payload = extractMediaPayload(message);
  if (!payload) return sendMsg(chatId, t(lang, 'media_type_unsupported'));
  if (!(await getAllowedMediaTypes(db)).includes(payload.mediaType)) return sendMsg(chatId, t(lang, 'media_type_disabled'));
  await getUploadOperation(session);
  const receipt = replay || await claimUploadItem(session, message, payload, ctx);
  if (receipt.session_id !== session.session_id) return replayUpload(receipt, chatId, lang, message);
  if (receipt.state === 'accepted' || receipt.state === 'duplicate' || receipt.state === 'rejected') return replayUpload(receipt, chatId, lang, message);
  const result = await acceptUploadItem(session, receipt);
  if (!result.accepted) return sendMsg(chatId, t(lang, result.limit ? 'upload_batch_limit' : 'operation_cancelled', {
    maxSession: LIMITS.MAX_PER_SESSION_UPLOAD, maxTotal: LIMITS.MAX_BUNDLE_ITEMS,
  }));
  if (result.op.mode === 'upload') {
    const bundle = await completeUploadSession(result.op.id, session);
    await optionalMirror(receipt, message, userId, chatId, lang);
    await optionalProjection(result.op.id, userId, lang);
    return reportBundle(bundle, chatId, lang, true);
  }
  if (!result.duplicate) await optionalMirror(receipt, message, userId, chatId, lang);
  return sendMsg(chatId, t(lang, 'file_added_done_hint'));
}

export async function handleUploadCommand(cmd, arg, message, userId, chatId, lang = 'en', role, ctx) {
  userId ||= message?.from?.id;
  chatId ||= message?.chat?.id;
  if (!['/upload', '/batch', '/cancel', '/done'].includes(cmd)) return false;
  role = await getFreshAdminRole(userId);
  if (getRoleLevel(role) < 2) return false;
  if (cmd === '/upload' || cmd === '/batch') {
    if (!(await getEffectiveOwnerId())) return sendMsg(chatId, t(lang, 'bot_uninitialized'));
    const started = await startUploadOperation(userId, cmd.slice(1), ctx);
    await linkUpdateOperation(ctx, 'upload', started.op.id);
    await markUpdateDispatch(ctx);
    if (['finalizing', 'complete'].includes(started.op.state)) {
      const bundle = await completeUploadSession(started.op.id);
      await optionalProjection(started.op.id, userId, lang);
      return reportBundle(bundle, chatId, lang, started.op.mode === 'upload');
    }
    if (!started.session || started.op.state !== 'open') return sendMsg(chatId, t(lang, 'operation_cancelled'));
    return sendMsg(chatId, t(lang, cmd === '/upload' ? 'upload_single_mode' : 'upload_batch_mode', { max: LIMITS.MAX_PER_SESSION_UPLOAD }));
  }
  if (cmd === '/cancel') {
    let receipt = await findUpdateReceipt(userId, ctx);
    if (receipt && receipt.kind !== 'cancel') return sendMsg(chatId, t(lang, 'operation_cancelled'));
    if (!receipt) {
      const session = await getAdminSession(userId);
      const target = session || { admin_id: Number(userId), session_id: crypto.randomUUID(), state: 'absent' };
      receipt = await claimUploadItem(target, { ...message, chat: { ...message?.chat, id: chatId } }, null, ctx, 'cancel');
    }
    if (receipt.state !== 'accepted') {
      const target = receipt.item.target;
      if (target?.state !== 'absent') await clearAdminSession(userId, target);
      await clearUserSession(userId);
      await markUploadReceipt(receipt, 'accepted');
    }
    return sendMsg(chatId, t(lang, 'operation_cancelled'));
  }
  const replay = await findUpdateReceipt(userId, ctx);
  if (replay) await linkUpdateOperation(ctx, 'upload', replay.session_id);
  if (replay && replay.kind !== 'done') return sendMsg(chatId, t(lang, 'operation_cancelled'));
  if (replay?.kind === 'done') {
    const previous = await db.select().from(uploadSessions).where(eq(uploadSessions.id, replay.session_id)).get();
    if (replay.state === 'rejected' || !previous || previous.mode === 'edit' || previous.state !== 'open') return replayUpload(replay, chatId, lang);
  }
  const session = await captureUploadSession(userId);
  if (session) await linkUpdateOperation(ctx, 'upload', session.session_id);
  if (!session) {
    const target = { admin_id: Number(userId), session_id: crypto.randomUUID(), state: 'absent' };
    const receipt = replay || await claimUploadItem(target, { ...message, chat: { ...message?.chat, id: chatId } }, null, ctx, 'done');
    await markUploadReceipt(receipt, 'rejected');
    return true;
  }
  if (replay && replay.session_id !== session.session_id) return replayUpload(replay, chatId, lang);
  if (session.mode === 'edit') {
    const managed = await getManagedBundleFresh(session.code, userId);
    if (!managed.allowed) return sendMsg(chatId, t(lang, 'bundle_access_denied'));
    await getUploadOperation(session);
    const receipt = replay || await claimUploadItem(session, { ...message, chat: { ...message?.chat, id: chatId } }, null, ctx, 'done');
    return replayUpload(receipt, chatId, lang);
  }
  if (session.state === 'active' && await uploadSessionExpired(session)) {
    const expired = await clearExpiredAdminSession(session, nowSec() - 600);
    if (expired.rowsAffected === 1) {
    return sendMsg(chatId, t(lang, 'operation_cancelled'));
    }
  }
  const receipt = replay || await claimUploadItem(session, { ...message, chat: { ...message?.chat, id: chatId } }, null, ctx, 'done');
  if (receipt.state === 'rejected') return sendMsg(chatId, t(lang, 'operation_cancelled'));
  const op = await sealUploadSession(session);
  if (!op) {
    await markUploadReceipt(receipt, 'rejected');
    return sendMsg(chatId, t(lang, 'bundle_save_error'));
  }
  await markUploadReceipt(receipt, 'accepted');
  const bundle = await completeUploadSession(op.id, session);
  await optionalProjection(op.id, userId, lang);
  return reportBundle(bundle, chatId, lang, op.mode === 'upload');
}

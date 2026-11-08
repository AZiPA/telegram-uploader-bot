import { getUserRole } from '../helpers.js';
import { canManageBundle } from './permissions.js';
import { renderHub, handleHubCommand, handleHubCallback } from './hub_panel.js';
import { renderReview, handleReviewCommand, handleReviewCallback } from './review_panel.js';
import { handleProtectedCallback } from './protected.js';
import { handleExpiryCommand, handleExpiryCallback } from './expiry.js';
import { handleRotationCommand, handleRotationCallback } from './rotation.js';
import { handleDeleteCommand, handleDeleteCallback } from './deletion.js';
import { handleSetNameCommand } from './setname.js';
import { handleSearchCommand } from '../filestore/search.js';

export {
  renderHub,
  renderReview,
  canManageBundle,
};

export async function handleBundleCommand(cmd, arg, message, userId, chatId, lang, role, ctx) {
  userId = userId || message?.from?.id;
  chatId = chatId || message?.chat?.id;
  lang = lang || 'en';
  role = role || (await getUserRole(userId));

  if (cmd === '/edit' || cmd === '/manage') {
    return handleHubCommand(cmd, arg, chatId, userId, lang, role);
  }
  if (cmd === '/review' || cmd.startsWith('/del_')) {
    return handleReviewCommand(cmd, arg, chatId, userId, lang, role);
  }
  if (cmd === '/setname') {
    return handleSetNameCommand(cmd, arg, chatId, userId, lang, role);
  }
  if (cmd === '/search') {
    return handleSearchCommand(arg, chatId, lang);
  }
  if (cmd === '/setexpiry') {
    return handleExpiryCommand(cmd, arg, chatId, userId, lang, role);
  }
  if (cmd === '/postbundle' || cmd === '/rotatelink') {
    return handleRotationCommand(cmd, arg, message, userId, chatId, lang, role, ctx);
  }
  if (cmd === '/delete') {
    return handleDeleteCommand(cmd, arg, chatId, userId, lang, role);
  }
}

export async function handleBundleCallback(data, cq, userId, chatId, messageId, lang, ctx) {
  const role = await getUserRole(userId);

  if (data.startsWith('mng:hub:')) {
    return handleHubCallback(data, cq, userId, chatId, messageId, lang, role);
  }
  if (data.startsWith('mng:review:') || data.startsWith('mng:ref:') || data.startsWith('mng:del:')) {
    return handleReviewCallback(data, cq, userId, chatId, messageId, lang, role);
  }
  if (data.startsWith('mng:testdl:') || data.startsWith('b:rint:') || data.startsWith('b:rot:') || data.startsWith('b:post:')) {
    return handleRotationCallback(data, cq, userId, chatId, messageId, lang, role, ctx);
  }
  if (data.startsWith('b:prot:') || data.startsWith('b:lock:') || data.startsWith('bnd:lock:')) {
    return handleProtectedCallback(data, cq, userId, chatId, messageId, lang, role);
  }
  if (data.startsWith('b:1x:') || data.startsWith('b:exp:')) {
    return handleExpiryCallback(data, cq, userId, chatId, messageId, lang, role);
  }
  if (data.startsWith('b:askdel:') || data.startsWith('b:yesdel:') || data.startsWith('b:nodel:')) {
    return handleDeleteCallback(data, cq, userId, chatId, messageId, lang, role);
  }
}

import { db as defaultDb, getConfig, setConfig } from '../helpers.js';

export const SUPPORTED_FILE_MEDIA_TYPES = [
  'photo',
  'document',
  'video',
  'audio',
  'voice',
  'video_note',
  'animation',
  'sticker',
];

export const DEFAULT_ALLOWED_MEDIA_TYPES = [
  'photo',
  'document',
  'video',
  'audio',
];

/**
 * Query systemConfig where key = 'allowed_media_types'.
 * Parse JSON safely. If absent or invalid, return default: ['photo', 'document', 'video', 'audio'].
 *
 * @param {object} [db]
 * @returns {Promise<Array<string>>}
 */
export async function getAllowedMediaTypes(db = defaultDb) {
  const val = await getConfig('allowed_media_types', null);
  if (!val) return [...DEFAULT_ALLOWED_MEDIA_TYPES];
  try {
    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const valid = parsed.filter((t) => SUPPORTED_FILE_MEDIA_TYPES.includes(t));
      if (valid.length > 0) return valid;
    }
  } catch (_) {}
  return [...DEFAULT_ALLOWED_MEDIA_TYPES];
}

/**
 * Toggle media type in allowed_media_types.
 * Validates mediaType is in SUPPORTED_FILE_MEDIA_TYPES.
 * Ensures at least 1 type remains enabled.
 * Saves back to systemConfig and updates config cache.
 *
 * @param {string} mediaType
 * @param {object} [db]
 * @returns {Promise<Array<string>>}
 */
export async function toggleMediaType(mediaType, db = defaultDb) {
  if (!SUPPORTED_FILE_MEDIA_TYPES.includes(mediaType)) {
    throw new Error(`Unsupported media type: ${mediaType}`);
  }
  const current = await getAllowedMediaTypes(db);
  let updated;
  if (current.includes(mediaType)) {
    if (current.length <= 1) {
      return current;
    }
    updated = current.filter((t) => t !== mediaType);
  } else {
    updated = [...current, mediaType];
  }
  const jsonVal = JSON.stringify(updated);
  await setConfig('allowed_media_types', jsonVal);
  return updated;
}

/**
 * Enable all 8 supported media types.
 *
 * @param {object} [db]
 * @returns {Promise<Array<string>>}
 */
export async function enableAllMediaTypes(db = defaultDb) {
  const updated = [...SUPPORTED_FILE_MEDIA_TYPES];
  const jsonVal = JSON.stringify(updated);
  await setConfig('allowed_media_types', jsonVal);
  return updated;
}

/**
 * Inspect message for all 8 supported file-id media types:
 * - photo: highest resolution (msg.photo[msg.photo.length - 1])
 * - document: msg.document
 * - video: msg.video
 * - audio: msg.audio
 * - voice: msg.voice
 * - video_note: msg.video_note
 * - animation: msg.animation
 * - sticker: msg.sticker
 *
 * @param {object} msg
 * @returns {{ mediaType: string, file_id: string, file_unique_id: string, file_name?: string, mime_type?: string, caption?: string, file_size: number }|null}
 */
export function extractMediaPayload(msg) {
  if (!msg || typeof msg !== 'object') return null;

  let mediaType = null;
  let targetObj = null;

  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    mediaType = 'photo';
    targetObj = msg.photo[msg.photo.length - 1];
  } else if (msg.animation) {
    mediaType = 'animation';
    targetObj = msg.animation;
  } else if (msg.document) {
    mediaType = 'document';
    targetObj = msg.document;
  } else if (msg.video) {
    mediaType = 'video';
    targetObj = msg.video;
  } else if (msg.audio) {
    mediaType = 'audio';
    targetObj = msg.audio;
  } else if (msg.voice) {
    mediaType = 'voice';
    targetObj = msg.voice;
  } else if (msg.video_note) {
    mediaType = 'video_note';
    targetObj = msg.video_note;
  } else if (msg.sticker) {
    mediaType = 'sticker';
    targetObj = msg.sticker;
  }

  if (!mediaType || !targetObj || !targetObj.file_id) {
    return null;
  }

  return {
    mediaType,
    file_id: targetObj.file_id,
    file_unique_id: targetObj.file_unique_id,
    file_name: targetObj.file_name || undefined,
    mime_type: targetObj.mime_type || undefined,
    caption: msg.caption || undefined,
    file_size: targetObj.file_size || 0,
  };
}

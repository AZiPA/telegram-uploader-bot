import {
  db, eq,
  forceChannels,
  tgApi, LIMITS, sendLogAlert
} from '../helpers.js';

const fjMemberCache = new Map();

function getCachedMembership(userId, channelId) {
  const key = `${userId}:${channelId}`;
  const entry = fjMemberCache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts > 60000) {
    fjMemberCache.delete(key);
    return false;
  }
  return true;
}

function setCachedMembership(userId, channelId) {
  if (fjMemberCache.size > 2000) {
    const cutoff = Date.now() - 60000;
    for (const [k, v] of fjMemberCache.entries()) {
      if (v.ts < cutoff) fjMemberCache.delete(k);
    }
    if (fjMemberCache.size > 2000) {
      const firstKey = fjMemberCache.keys().next().value;
      if (firstKey) fjMemberCache.delete(firstKey);
    }
  }
  fjMemberCache.set(`${userId}:${channelId}`, { ts: Date.now() });
}

export async function checkUserMembership(userId, lang) {
  const channels = await db.select().from(forceChannels).where(eq(forceChannels.is_active, true)).limit(LIMITS.MAX_FORCE_JOIN_CHANNELS).all();
  if (!channels?.length) return { ok: true, unjoinedChannels: [] };
  const unjoined = [];
  const chunkSize = LIMITS.MAX_OUTGOING_SOCKETS || 6;
  for (let i = 0; i < channels.length; i += chunkSize) {
    const wave = channels.slice(i, i + chunkSize);
    const results = await Promise.all(wave.map(async (ch) => {
      try {
        if (getCachedMembership(userId, ch.channel_id)) {
          return { ch, isJoined: true };
        }
        const res = await tgApi.getChatMember({ chat_id: ch.channel_id, user_id: userId });
        const st = res?.status;
        const isJoined = st === 'creator' || st === 'administrator' || st === 'member' || (st === 'restricted' && res.is_member === true);
        if (isJoined) {
          setCachedMembership(userId, ch.channel_id);
        }
        return { ch, isJoined };
      } catch (err) {
        const errCode = err?.code ?? err?.status;
        const errDesc = String(err?.description || err?.message || '').toLowerCase();
        const isTransient = errCode === 429 || (errCode >= 500 && errCode < 600);
        if (isTransient) {
          console.error(`[force-join] Transient error checking channel ${ch.channel_id}: ${errCode} ${errDesc}`);
          return { ch, isJoined: false };
        }
        if (!isTransient) {
          const isChannelBroken = errDesc.includes('chat not found') ||
            errDesc.includes('kicked') ||
            errDesc.includes('forbidden') ||
            errDesc.includes('inaccessible');
          if (isChannelBroken) {
            await db.update(forceChannels).set({ is_active: false }).where(eq(forceChannels.channel_id, ch.channel_id)).run();
            await sendLogAlert(`[Force-Join] Channel ${ch.channel_id} deactivated: ${errDesc}`).catch(() => {});
            return { ch, isJoined: true };
          }
        }
        return { ch, isJoined: false };
      }
    }));
    for (const r of results) { if (!r.isJoined) unjoined.push(r.ch); }
  }
  return { ok: unjoined.length === 0, unjoinedChannels: unjoined };
}

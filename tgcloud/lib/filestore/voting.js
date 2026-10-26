import { db, eq, and, sql, bundles, bundleVotes, tgApi, ACTIONS, answerCq, nowSec } from '../helpers.js';
import { buildDeliveryKeyboard } from '../shared/buttons.js';
import { isPremiumEmojiEnabled } from '../shared/emojis.js';
import { t } from '../locales/index.js';

export async function handleVoteCallback(data, cq, userId, chatId, messageId, lang) {
  if (data.startsWith(ACTIONS.VOTE_LIKE) || data.startsWith(ACTIONS.VOTE_DISLIKE)) {
    const voteType = data.startsWith(ACTIONS.VOTE_LIKE) ? 'like' : 'dislike';
    const code = data.slice((voteType === 'like' ? ACTIONS.VOTE_LIKE : ACTIONS.VOTE_DISLIKE).length);

    // Guard against voting on deleted or non-existent bundles
    const bundleExists = await db
      .select({ code: bundles.code })
      .from(bundles)
      .where(eq(bundles.code, code))
      .get();
    if (!bundleExists) {
      return answerCq(cq, t(lang, 'file_not_found'), true);
    }

    const existing = await db.select({ id: bundleVotes.id }).from(bundleVotes).where(and(eq(bundleVotes.code, code), eq(bundleVotes.user_id, userId))).get();
    if (existing) {
      return answerCq(cq, t(lang, 'vote_already'), true);
    }
    try {
      const res = await db.insert(bundleVotes).values({
        code,
        user_id: userId,
        vote_type: voteType,
        created_at: nowSec(),
      }).onConflictDoNothing().run();
      if ((res?.rowsAffected ?? 1) === 0) {
        return answerCq(cq, t(lang, 'vote_already'), true);
      }
    } catch {
      return answerCq(cq, t(lang, 'vote_already'), true);
    }
    const votes = await db.select({
      likes: sql`COUNT(CASE WHEN vote_type = 'like' THEN 1 END)`,
      dislikes: sql`COUNT(CASE WHEN vote_type = 'dislike' THEN 1 END)`,
    }).from(bundleVotes).where(eq(bundleVotes.code, code)).get();
    const kb = buildDeliveryKeyboard(lang, code, {
      likes: votes?.likes || 0,
      dislikes: votes?.dislikes || 0,
      isPremium: await isPremiumEmojiEnabled(db),
    });
    await tgApi.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: kb }).catch(() => {});
    return answerCq(cq);
  }
  return false;
}

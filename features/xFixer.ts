// src/features/xFixer.ts
// ─────────────────────────────────────────────────────────────
// When anyone posts a message containing an x.com or twitter.com
// link, the bot:
//   1. Deletes the original message
//   2. Webhook-resends any non-link text the user included
//   3. Webhook-resends the link(s) converted to vxtwitter.com
//
// Both sends appear with the original user's avatar + display name,
// so it's seamless. Follows the same webhook-cache pattern as
// handleVoiceTranscribe in index.ts.
// ─────────────────────────────────────────────────────────────

import { Message, TextChannel } from 'discord.js';

// Reuse a single Map passed in from index.ts (same pattern as voiceWebhookCache)
// so we don't spin up duplicate webhooks.
export async function handleXFixer(
  message: Message,
  webhookCache: Map<string, string>,
): Promise<void> {
  if (!message.guild) return;
  if (message.author.bot) return;

  // ── 1. Check for x.com / twitter.com links ───────────────
  const X_REGEX = /https?:\/\/(www\.)?(x\.com|twitter\.com)\/[^\s]*/gi;
  const matches = message.content.match(X_REGEX);
  if (!matches) return;

  // ── 2. Build the "everything else" text ──────────────────
  const textWithoutLinks = message.content
    .replace(X_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Convert each matched URL to vxtwitter
  const fixedLinks = matches.map(url =>
    url.replace(/(x\.com|twitter\.com)/i, 'vxtwitter.com'),
  );

  // ── 3. Get or create the webhook ─────────────────────────
  const channel = message.channel as TextChannel;
  let webhook;

  try {
    const hooks = await channel.fetchWebhooks();
    const cachedId = webhookCache.get(channel.id);
    webhook = cachedId
      ? hooks.get(cachedId)
      : hooks.find(h => h.owner?.id === message.client.user?.id);

    if (!webhook) {
      webhook = await channel.createWebhook({ name: 'Link Fixer' });
    }
    webhookCache.set(channel.id, webhook.id);
  } catch (err) {
    console.error('[xFixer] Failed to get/create webhook:', err);
    return;
  }

  const member = message.member;
  const username = member?.displayName ?? message.author.username;
  const avatarURL =
    member?.displayAvatarURL({ size: 256 }) ??
    message.author.displayAvatarURL({ size: 256 });

  // ── 4. Delete the original ────────────────────────────────
  try {
    await message.delete();
  } catch (err) {
    // Missing permissions or already deleted — bail out rather than double-posting
    console.warn('[xFixer] Could not delete original message:', err);
    return;
  }

  // ── 5. Resend non-link text if there was any ─────────────
  if (textWithoutLinks.length > 0) {
    await webhook.send({
      content: textWithoutLinks,
      username,
      avatarURL,
      allowedMentions: { parse: [] }, // don't ping people when resending
    });
  }

  // ── 6. Resend each fixed link ─────────────────────────────
  for (const link of fixedLinks) {
    await webhook.send({
      content: link,
      username,
      avatarURL,
    });
  }
}
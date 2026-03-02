import { Client, MessageReaction, User, EmbedBuilder, PartialMessageReaction, PartialUser } from "discord.js";
import { getStarboardConfig, saveStarboardMessage, getExistingStarboardMessage } from "../utils/database";


export default function setupStarboard(client: Client) {
  client.on("messageReactionAdd", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await handleStarReaction(reaction, user);
  });

  client.on("messageReactionRemove", async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await handleStarReaction(reaction, user);
  });
}

async function handleStarReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
  if (user.bot) return;

  // Fetch partials
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  if (reaction.emoji.name !== "⭐") return;

  const message = reaction.message;
  if (!message.guild || !message.author) return;

  const config = await getStarboardConfig(message.guild.id);
  if (!config) return;

  // Only allow stars from specific channels (if configured)
  if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(message.channel.id)) return;

  // Prevent starring starboard messages
  if (message.channel.id === config.channelId) return;

  const starCount = reaction.count ?? 0;
  const starboardChannel = message.guild.channels.cache.get(config.channelId);
  if (!starboardChannel?.isTextBased()) return;

  const existing = await getExistingStarboardMessage(message.id);

  if (existing) {
    // Update star count
    try {
      const starboardMsg = await starboardChannel.messages.fetch(existing.starboardMessageId);
      if (starCount < config.threshold) {
        // Remove from starboard if below threshold
        await starboardMsg.delete();
        return;
      }
      const updatedEmbed = buildEmbed(message as any, starCount);
      await starboardMsg.edit({ content: `⭐ **${starCount}** <#${message.channel.id}>`, embeds: [updatedEmbed] });
    } catch {
      // Message may have been deleted
    }
    return;
  }

  if (starCount < config.threshold) return;

  // Post new starboard message
  const embed = buildEmbed(message as any, starCount);
  const sent = await starboardChannel.send({
    content: `⭐ **${starCount}** <#${message.channel.id}>`,
    embeds: [embed]
  });

  await saveStarboardMessage(message.id, sent.id, message.guild.id);
}

function buildEmbed(message: any, starCount: number) {
  const embed = new EmbedBuilder()
    .setAuthor({
      name: message.author.username,
      iconURL: message.author.displayAvatarURL()
    })
    .setDescription(message.content || "*No text content*")
    .addFields(
      { name: "⭐ Stars", value: `${starCount}`, inline: true },
      { name: "Source", value: `[Jump to message](${message.url})`, inline: true }
    )
    .setFooter({ text: `#${message.channel.name} • ID: ${message.id}` })
    .setTimestamp(message.createdAt)
    .setColor(0xFFAC33);

  // Attach image if present
  const image = message.attachments.first();
  if (image?.contentType?.startsWith("image/")) {
    embed.setImage(image.url);
  }

  return embed;
}
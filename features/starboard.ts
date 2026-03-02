import { Client, MessageReaction, User, EmbedBuilder, PartialMessageReaction, PartialUser, GuildMember } from "discord.js";
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
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();

  const message = reaction.message;
  if (!message.guild || !message.author) return;

  const config = await getStarboardConfig(message.guild.id);
  if (!config) return;

  if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(message.channel.id)) return;
  if (message.channel.id === config.channelId) return;

  const starCount = reaction.count ?? 0;
  const starboardChannel = message.guild.channels.cache.get(config.channelId);
  if (!starboardChannel?.isTextBased()) return;

  const member = await message.guild.members.fetch(message.author.id);

  const existing = await getExistingStarboardMessage(message.id);
  if (existing) {
    try {
      const starboardMsg = await starboardChannel.messages.fetch(existing.starboardMessageId);
      if (starCount < config.threshold) {
        await starboardMsg.delete();
        return;
      }
      await message.fetch();
      const updatedEmbed = await buildEmbed(message as any, starCount, member);
      await starboardMsg.edit({ content: `⭐ **${starCount}** <#${message.channel.id}>`, embeds: [updatedEmbed] });
    } catch {
    }
    return;
  }

  if (starCount < config.threshold) return;

  const embed = await buildEmbed(message as any, starCount, member);
  const sent = await starboardChannel.send({
    content: `⭐ **${starCount}** <#${message.channel.id}>`,
    embeds: [embed]
  });
  await saveStarboardMessage(message.id, sent.id, message.guild.id);
}

async function buildEmbed(message: any, starCount: number, member: GuildMember) {
  const embed = new EmbedBuilder()
    .setAuthor({
      name: member.displayName, //#####
      iconURL: member.displayAvatarURL()
    })
    .setColor(0xFFAC33);
  
  // Show the message being replied to
  if (message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      const repliedMember = await message.guild.members.fetch(repliedTo.author.id)
      embed.addFields({
        name: `↩️ Replying to ${repliedMember.displayName}`,
        value: repliedTo.content || "*No text content*"
      });
    } catch {
      // replied message may have been deleted
    }
  }

  embed
    //.setDescription(message.content || "")
    .addFields(
      { name: message.content, value: ``, inline: true },
    )
    .setFooter({ text: `🦀 Reactions ` + `${starCount}`})
    .setTimestamp(message.createdAt);

  const image = message.attachments.first();
  if (image?.contentType?.startsWith("image/")) {
    embed.setImage(image.url);
  }

  const sticker = message.stickers?.first();
  if (sticker) {
    embed.setImage(`https://media.discordapp.net/stickers/${sticker.id}.png`);
    if (!message.content) embed.setTitle(`🎭 Sticker: ${sticker.name}`);
  }

  // Tenor GIF support
  const tenorMatch = message.content?.match(/https:\/\/tenor\.com\/view\/[^\s]+/);
  if (tenorMatch) {
    embed.setImage(tenorMatch[0]);
    embed.setTitle(null); // remove link from title since its shown as image
  }


  // Embed from linked content (e.g. twitter preview)
  if (message.embeds?.length > 0) {
    const firstEmbed = message.embeds[0];
    if (firstEmbed.image) embed.setImage(firstEmbed.image.url);
    else if (firstEmbed.thumbnail) embed.setImage(firstEmbed.thumbnail.url);
  }

  return embed;
}
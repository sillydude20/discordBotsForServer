import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  GuildMember,
} from "discord.js";
import { getStarboardConfig, setStarboardConfig, getAllStarboardMessages, deleteStarboardMessage, saveStarboardMessage, getCachedMessageById } from "../utils/database";




export const data = new SlashCommandBuilder()
  .setName("starboard")
  .setDescription("Configure the starboard")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("setchannel")
      .setDescription("Set the starboard output channel")
      .addChannelOption(opt =>
        opt.setName("channel")
          .setDescription("The channel to post starred messages in")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("setthreshold")
      .setDescription("Set how many stars are needed")
      .addIntegerOption(opt =>
        opt.setName("amount")
          .setDescription("Number of stars required")
          .setMinValue(1)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("addchannel")
      .setDescription("Allow a channel to be starred from")
      .addChannelOption(opt =>
        opt.setName("channel")
          .setDescription("Channel to allow")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("removechannel")
      .setDescription("Remove a channel from the allowed list")
      .addChannelOption(opt =>
        opt.setName("channel")
          .setDescription("Channel to remove")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  
  .addSubcommand(sub =>
    sub.setName("status")
      .setDescription("View current starboard configuration")
  ).addSubcommand(sub =>
  sub.setName("refresh")
    .setDescription("Repost any starboard entries missing from the starboard channel")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Server owner only

  const guildId = interaction.guildId!;
  const sub = interaction.options.getSubcommand();

  // Load existing config or start fresh
  const config = getStarboardConfig(guildId) ?? {
    channelId: "",
    threshold: 3,
    allowedChannels: []
  };

  if (sub === "setchannel") {
    const channel = interaction.options.getChannel("channel", true);
    config.channelId = channel.id;
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ Starboard channel set to <#${channel.id}>`, ephemeral: true });

  } else if (sub === "setthreshold") {
    const amount = interaction.options.getInteger("amount", true);
    config.threshold = amount;
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ Star threshold set to **${amount}** ⭐`, ephemeral: true });

  } else if (sub === "addchannel") {
    const channel = interaction.options.getChannel("channel", true);
    if (config.allowedChannels.includes(channel.id)) {
      await interaction.reply({ content: `⚠️ <#${channel.id}> is already in the allowed list.`, ephemeral: true });
      return;
    }
    config.allowedChannels.push(channel.id);
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ <#${channel.id}> added to allowed channels.`, ephemeral: true });

  } else if (sub === "removechannel") {
    const channel = interaction.options.getChannel("channel", true);
    config.allowedChannels = config.allowedChannels.filter(id => id !== channel.id);
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ <#${channel.id}> removed from allowed channels.`, ephemeral: true });

  } else if (sub === "status") {
    if (!config.channelId) {
      await interaction.reply({ content: "⚠️ Starboard is not configured yet. Use `/starboard setchannel` first.", ephemeral: true });
      return;
    }
    const channels = config.allowedChannels.length > 0
      ? config.allowedChannels.map(id => `<#${id}>`).join(", ")
      : "All channels";
    await interaction.reply({
      content: `📌 **Starboard Config**\nChannel: <#${config.channelId}>\nThreshold: **${config.threshold}** ⭐\nAllowed channels: ${channels}`,
      ephemeral: true
    });
  }  else if (sub === "refresh") {
  await interaction.deferReply({ ephemeral: true });

  if (!config.channelId) {
    await interaction.editReply({ content: "⚠️ Starboard is not configured. Use `/starboard setchannel` first." });
    return;
  }

  const starboardChannel = interaction.guild!.channels.cache.get(config.channelId)
    ?? await interaction.guild!.channels.fetch(config.channelId).catch(() => null);

  if (!starboardChannel?.isTextBased()) {
    await interaction.editReply({ content: `❌ Starboard channel <#${config.channelId}> not found. Set a new one with \`/starboard setchannel\`.` });
    return;
  }

  const rows = getAllStarboardMessages(guildId);

  if (rows.length === 0) {
    await interaction.editReply({ content: "ℹ️ No starboard entries in the database." });
    return;
  }

  let intact = 0, reposted = 0, failed = 0;

  for (const row of rows) {
    const stillExists = await starboardChannel.messages.fetch(row.starboardMessageId).catch(() => null);
    if (stillExists) { intact++; continue; }

    // Stale entry — remove it
    deleteStarboardMessage(row.messageId);

    // Look up original message details from the mod-log cache
    const cached = getCachedMessageById(row.messageId);
    if (!cached) { failed++; continue; }

    try {
      const originChannel = interaction.guild!.channels.cache.get(cached.channelId)
        ?? await interaction.guild!.channels.fetch(cached.channelId).catch(() => null);
      if (!originChannel?.isTextBased()) { failed++; continue; }

      const originalMsg = await originChannel.messages.fetch(row.messageId).catch(() => null);
      if (!originalMsg) { failed++; continue; }

      const member = await interaction.guild!.members.fetch(cached.authorId).catch(() => null);
      if (!member) { failed++; continue; }

      const starReaction = originalMsg.reactions.cache.get("⭐");
      const starCount = starReaction?.count ?? 0;

      const embed = await buildStarboardEmbed(originalMsg, starCount, member);
      const sent = await starboardChannel.send({
        content: `⭐ **${starCount}** <#${cached.channelId}>`,
        embeds: [embed]
      });
      saveStarboardMessage(row.messageId, sent.id, guildId);
      reposted++;
    } catch (e) {
      console.warn("[starboard refresh] Failed to repost:", e);
      failed++;
    }
  }

  await interaction.editReply({
    content:
      `✅ **Starboard refresh complete**\n` +
      `📋 Total tracked: **${rows.length}**\n` +
      `✔️ Already intact: **${intact}**\n` +
      `📌 Reposted: **${reposted}**` +
      (failed > 0 ? `\n⚠️ Could not restore: **${failed}** (original message deleted or channel gone)` : ""),
  });
}
  
}

function formatContent(content: string): string {
  if (!content) return "*No text content*";
  content = content.replace(/<a?:(\w+):(\d+)>/g, (match, name, id) => {
    const ext = match.startsWith("<a:") ? "gif" : "png";
    return `[:${name}:](https://cdn.discordapp.com/emojis/${id}.${ext})`;
  });
  return content;
}

async function buildStarboardEmbed(message: any, starCount: number, member: GuildMember) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL() })
    .setColor(0xFFAC33);

  if (message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      const repliedMember = await message.guild.members.fetch(repliedTo.author.id);
      embed.addFields({
        name: `↩️ Replying to ${repliedMember.displayName}`,
        value: repliedTo.content || "*No text content*"
      });
    } catch {}
  }

  embed
    .addFields({ name: message.content || "*No text content*", value: "", inline: true })
    .setFooter({ text: `🦀 Reactions ${starCount}` })
    .setTimestamp(message.createdAt);

  const image = message.attachments.first();
  if (image?.contentType?.startsWith("image/")) embed.setImage(image.url);

  const sticker = message.stickers?.first();
  if (sticker) {
    embed.setImage(`https://media.discordapp.net/stickers/${sticker.id}.png`);
    if (!message.content) embed.setTitle(`🎭 Sticker: ${sticker.name}`);
  }

  const tenorMatch = message.content?.match(/https:\/\/tenor\.com\/view\/[^\s]+/);
  if (tenorMatch) { embed.setImage(tenorMatch[0]); embed.setTitle(null); }

  if (message.embeds?.length > 0) {
    const first = message.embeds[0];
    if (first.image) embed.setImage(first.image.url);
    else if (first.thumbnail) embed.setImage(first.thumbnail.url);
  }

  return embed;
}
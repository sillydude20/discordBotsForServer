// src/features/modlog.ts
// ─────────────────────────────────────────────────────────────
// Logs every message to a private mod-log channel:
//   • Immediately when sent (so mods see it even if deleted fast)
//   • Again when deleted (with a 🗑 deleted notice on the log entry)
//
// Commands:
//   /modlog set    #channel  — set the mod-log channel
//   /modlog remove           — disable mod-log
//   /modlog status           — show current config
// ─────────────────────────────────────────────────────────────

import {
  Message,
  PartialMessage,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  Snowflake,
  Collection,
} from 'discord.js';
import {
  getModLogConfig,
  saveModLogConfig,
  deleteModLogConfig,
} from '../utils/database';

// ── Types ─────────────────────────────────────────────────────

interface ModLogConfig {
  guildId: string;
  channelId: string;
}

// ── Stores ────────────────────────────────────────────────────

// Map<guildId, ModLogConfig> — populated from DB on startup
const modLogConfigs = new Map<string, ModLogConfig>();

export function loadModLogConfigs(): void {
  const rows = getModLogConfig();
  modLogConfigs.clear();
  for (const row of rows) {
    modLogConfigs.set(row.guildId, { guildId: row.guildId, channelId: row.channelId });
  }
  console.log(`📦 Loaded ${modLogConfigs.size} mod-log config(s) from database`);
}

// Map<originalMessageId, logChannelMessageId>
// Used to edit the log entry when the original is deleted
const logMessageMap = new Map<Snowflake, Snowflake>();

// Cache of message content/metadata keyed by message ID.
// Populated on send so we still have the data after Discord evicts it.
interface CachedMessage {
  authorId: string;
  authorTag: string;
  authorAvatar: string;
  channelId: string;
  guildId: string;
  content: string;
  createdTimestamp: number;
  attachments: { name: string; url: string; contentType: string | null }[];
  replyToId?: string;
}
const messageCache = new Map<Snowflake, CachedMessage>();
const MAX_CACHE = 10_000; // evict oldest entries to avoid unbounded growth

// ── Slash command ─────────────────────────────────────────────

export const modLogCommand = new SlashCommandBuilder()
  .setName('modlog')
  .setDescription('Configure the mod-log channel for deleted messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set the mod-log channel (or auto-create one)')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to send logs to (leave empty to auto-create)')
          .setRequired(false),
      )
      .addRoleOption((opt) =>
        opt
          .setName('role')
          .setDescription('Role that can see the mod-log (used when auto-creating)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('remove').setDescription('Disable mod-log logging'),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show current mod-log configuration'),
  );

// ── Interaction handler ───────────────────────────────────────

export async function handleModLogInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== 'modlog') return;
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ This command must be used in a server.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // /modlog set
  if (sub === 'set') {
    const channelOption = interaction.options.getChannel('channel', false);
    const roleOption    = interaction.options.getRole('role', false);
    let targetChannelId: string;

    if (channelOption) {
      targetChannelId = channelOption.id;
    } else {
      await interaction.deferReply({ ephemeral: true });
      try {
        const created = await interaction.guild.channels.create({
          name: 'mod-log',
          type: ChannelType.GuildText,
          topic: 'Message log — mod eyes only',
          permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            ...(roleOption
              ? [{ id: roleOption.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] }]
              : []),
          ],
        });
        targetChannelId = created.id;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await interaction.editReply({ content: `❌ Failed to create channel: ${msg}` });
        return;
      }
    }

    modLogConfigs.set(interaction.guild.id, { guildId: interaction.guild.id, channelId: targetChannelId });
    saveModLogConfig(interaction.guild.id, targetChannelId);

    const reply = { content: `✅ Mod-log set to <#${targetChannelId}>. All messages will be logged there.` };
    if (interaction.deferred) {
      await interaction.editReply(reply);
    } else {
      await interaction.reply({ ...reply, ephemeral: true });
    }
    return;
  }

  // /modlog remove
  if (sub === 'remove') {
    if (!modLogConfigs.has(interaction.guild.id)) {
      await interaction.reply({ content: 'ℹ️ Mod-log is not currently configured.', ephemeral: true });
      return;
    }
    modLogConfigs.delete(interaction.guild.id);
    deleteModLogConfig(interaction.guild.id);
    await interaction.reply({ content: '🗑 Mod-log disabled.', ephemeral: true });
    return;
  }

  // /modlog status
  if (sub === 'status') {
    const config = modLogConfigs.get(interaction.guild.id);
    if (!config) {
      await interaction.reply({ content: 'ℹ️ Mod-log is not configured. Use `/modlog set` to enable it.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `📋 Mod-log is active. Logging all messages to <#${config.channelId}>.`,
      ephemeral: true,
    });
  }
}

// ── Build embed ───────────────────────────────────────────────

async function buildMessageEmbed(
  message: Message,
  deleted: boolean,
): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder()
    .setColor(deleted ? Colors.Red : Colors.Blurple)
    .setTitle(deleted ? '🗑 Message Deleted' : '💬 Message Sent')
    .setTimestamp()
    .setFooter({ text: `Message ID: ${message.id}` });

  // Author
  embed.setAuthor({
    name: message.author.tag,
    iconURL: message.author.displayAvatarURL(),
  });

  embed.addFields(
    { name: 'Author',   value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
    { name: 'Channel',  value: `<#${message.channelId}>`, inline: true },
    { name: 'Sent',     value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`, inline: true },
  );

  // Reply context — same pattern as starboard
  if (message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      const repliedMember = await message.guild!.members.fetch(repliedTo.author.id);
      const replyContent = repliedTo.content || '*No text content*';
      embed.addFields({
        name: `↩️ Replying to ${repliedMember.displayName}`,
        value: replyContent.length > 1024 ? replyContent.slice(0, 1021) + '...' : replyContent,
      });
    } catch {
      embed.addFields({ name: '↩️ Was a reply', value: '*Original message no longer available*' });
    }
  }

  // Content
  const content = message.content;
  embed.addFields({
    name: 'Content',
    value: content && content.length > 0
      ? (content.length > 1024 ? content.slice(0, 1021) + '...' : content)
      : '*No text content*',
  });

  // Attachments
  if (message.attachments.size > 0) {
    const list = message.attachments.map((a) => `[${a.name}](${a.url})`).join('\n');
    embed.addFields({ name: `Attachments (${message.attachments.size})`, value: list });
    const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (image) embed.setImage(image.url);
  }

  // Embeds
  if (message.embeds.length > 0) {
    embed.addFields({ name: 'Had Embeds', value: `${message.embeds.length} embed(s)` });
  }

  return embed;
}

// ── Log message on send ───────────────────────────────────────

export async function logNewMessage(message: Message): Promise<void> {
  // Skip bots, DMs, and the mod-log channel itself
  if (message.author.bot) return;
  if (!message.guild) return;

  const config = modLogConfigs.get(message.guild.id);
  if (!config) return;

  // Don't log messages sent inside the mod-log channel
  if (message.channelId === config.channelId) return;

  try {
    const logChannel = await message.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const embed = await buildMessageEmbed(message, false);
    const logMsg = await (logChannel as TextChannel).send({ embeds: [embed] });

    // Store the mapping so we can update this entry if the message gets deleted
    logMessageMap.set(message.id, logMsg.id);

    // Cache message content so it's available even after Discord evicts it
    messageCache.set(message.id, {
      authorId:         message.author.id,
      authorTag:        message.author.tag,
      authorAvatar:     message.author.displayAvatarURL(),
      channelId:        message.channelId,
      guildId:          message.guild!.id,
      content:          message.content ?? '',
      createdTimestamp: message.createdTimestamp,
      attachments:      message.attachments.map((a) => ({
        name:        a.name,
        url:         a.url,
        contentType: a.contentType ?? null,
      })),
      replyToId: message.reference?.messageId,
    });
    // Evict oldest entry if cache is too large
    if (messageCache.size > MAX_CACHE) {
      messageCache.delete(messageCache.keys().next().value!);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log new message: ${msg}`);
  }
}

// ── Mark as deleted when the original is removed ──────────────

export async function logDeletedMessage(
  message: Message | PartialMessage,
): Promise<void> {
  if (!message.guild) return;
  if (message.author?.bot) return;

  const config = modLogConfigs.get(message.guild.id);
  if (!config) return;

  const logEntryId = logMessageMap.get(message.id);
  if (!logEntryId) return; // no log entry to update (e.g. sent before bot started)

  try {
    const logChannel = await message.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const logEntry = await (logChannel as TextChannel).messages.fetch(logEntryId).catch(() => null);
    if (!logEntry) return;

    // Use our own cache — Discord has already evicted the message by this point
    const cached = messageCache.get(message.id);

    const embed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle('🗑 Message Deleted')
      .setTimestamp()
      .setFooter({ text: `Message ID: ${message.id}` });

    if (cached) {
      embed.setAuthor({ name: cached.authorTag, iconURL: cached.authorAvatar });
      embed.addFields(
        { name: 'Author',   value: `<@${cached.authorId}> (${cached.authorTag})`, inline: true },
        { name: 'Channel',  value: `<#${cached.channelId}>`, inline: true },
        { name: 'Sent',     value: `<t:${Math.floor(cached.createdTimestamp / 1000)}:F>`, inline: true },
      );

      // Reply context from cache
      if (cached.replyToId) {
        try {
          const repliedTo = await (logChannel as TextChannel).guild.channels
            .fetch(cached.channelId)
            .then((ch) => ch?.isTextBased() ? (ch as TextChannel).messages.fetch(cached.replyToId!) : null)
            .catch(() => null);
          if (repliedTo) {
            const repliedMember = await message.guild.members.fetch(repliedTo.author.id).catch(() => null);
            const displayName = repliedMember?.displayName ?? repliedTo.author.tag;
            const replyContent = repliedTo.content || '*No text content*';
            embed.addFields({
              name: `↩️ Replying to ${displayName}`,
              value: replyContent.length > 1024 ? replyContent.slice(0, 1021) + '...' : replyContent,
            });
          } else {
            embed.addFields({ name: '↩️ Was a reply', value: '*Original message no longer available*' });
          }
        } catch {
          embed.addFields({ name: '↩️ Was a reply', value: '*Original message no longer available*' });
        }
      }

      embed.addFields({
        name: 'Content',
        value: cached.content.length > 0
          ? (cached.content.length > 1024 ? cached.content.slice(0, 1021) + '...' : cached.content)
          : '*No text content*',
      });

      if (cached.attachments.length > 0) {
        const list = cached.attachments.map((a) => `[${a.name}](${a.url})`).join('');
        embed.addFields({ name: `Attachments (${cached.attachments.length})`, value: list });
        const image = cached.attachments.find((a) => a.contentType?.startsWith('image/'));
        if (image) embed.setImage(image.url);
      }
    } else {
      // Fallback: message was sent before the bot started or cache was cleared
      embed.addFields(
        { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
        { name: 'Content', value: '*Message content unavailable — was sent before bot started*' },
      );
    }

    await logEntry.edit({ embeds: [embed] });

    // Clean up both maps
    logMessageMap.delete(message.id);
    messageCache.delete(message.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to update deleted message log: ${msg}`);
  }
}

// ── Bulk delete ───────────────────────────────────────────────

export async function logBulkDelete(
  messages: ReadonlyMap<Snowflake, Message | PartialMessage>,
  channel: TextChannel,
): Promise<void> {
  if (!channel.guild) return;

  const config = modLogConfigs.get(channel.guild.id);
  if (!config) return;

  try {
    const logChannel = await channel.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(Colors.Orange)
      .setTitle('🗑 Bulk Delete')
      .setTimestamp()
      .addFields(
        { name: 'Channel', value: `<#${channel.id}>`, inline: true },
        { name: 'Messages Deleted', value: `${messages.size}`, inline: true },
      );

    const preview = [...messages.values()]
      .filter((m): m is Message => !m.partial && !!m.author && !m.author.bot)
      .slice(0, 20)
      .map((m) => `**${m.author.tag}**: ${m.content?.slice(0, 100) ?? '*no content*'}`)
      .join('\n');

    if (preview) {
      embed.addFields({
        name: 'Preview (up to 20)',
        value: preview.length > 1024 ? preview.slice(0, 1021) + '...' : preview,
      });
    }

    await (logChannel as TextChannel).send({ embeds: [embed] });

    // Clean up map entries for bulk-deleted messages
    for (const id of messages.keys()) logMessageMap.delete(id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log bulk delete: ${msg}`);
  }
}
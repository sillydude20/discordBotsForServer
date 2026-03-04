// src/features/modlog.ts
// ─────────────────────────────────────────────────────────────
// Commands:
//   /modlog set             — set/create the mod-log channel
//   /modlog remove          — disable mod-log
//   /modlog status          — show current config
//   /modlog ignore #channel — stop logging messages from a channel
//   /modlog unignore #channel
//   /modlog ignorelist      — show all ignored channels
//   /modlog setcommandlog   — set a separate channel for command usage logs
//   /modlog removecommandlog — remove the separate command log channel
// ─────────────────────────────────────────────────────────────

import {
  Message,
  PartialMessage,
  GuildMember,
  PartialGuildMember,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  Snowflake,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  getModLogConfig,
  saveModLogConfig,
  deleteModLogConfig,
  getModLogIgnoredChannels,
  addModLogIgnoredChannel,
  removeModLogIgnoredChannel,
  getCachedMessages,
  saveCachedMessage,
  deleteCachedMessage,
  getLogMessageMap,
  saveLogMessageMap,
  deleteLogMessageMap,
  getCmdLogConfig,
  saveCmdLogConfig,
  deleteCmdLogConfig,
} from '../utils/database';

import { request } from 'undici';

interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  try {
    const { body, headers } = await request(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
      maxRedirections: 3,
    });
    const contentType = headers['content-type'] ?? '';
    if (!contentType.includes('text/html')) return null;

    const html = await body.text();
    const get = (prop: string) => {
      const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
        ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return match?.[1];
    };

    return {
      title:       get('og:title')       ?? get('twitter:title'),
      description: get('og:description') ?? get('twitter:description'),
      image:       get('og:image')       ?? get('twitter:image'),
      siteName:    get('og:site_name'),
    };
  } catch {
    return null;
  }
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>)"]+/g)].map(m => m[0]).slice(0, 3);
}

// ── Types ─────────────────────────────────────────────────────

interface ModLogConfig {
  guildId: string;
  channelId: string;
}

// ── In-memory stores ──────────────────────────────────────────

const modLogConfigs   = new Map<string, ModLogConfig>();
const cmdLogConfigs   = new Map<string, string>();
const ignoredChannels = new Map<string, Set<string>>();
const logMessageMap   = new Map<Snowflake, Snowflake>();
const messageCache    = new Map<Snowflake, CachedMessage>();

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

const MAX_CACHE = 10_000;

// ── User ID button helper ─────────────────────────────────────

function buildUserIdRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_uid_${userId}`)
      .setLabel('User ID')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🪪'),
  );
}

// ── Load everything from DB on startup ───────────────────────

export function loadModLogConfigs(): void {
  const configRows = getModLogConfig();
  modLogConfigs.clear();
  for (const row of configRows) {
    modLogConfigs.set(row.guildId, { guildId: row.guildId, channelId: row.channelId });
  }

  const cmdLogRows = getCmdLogConfig();
  cmdLogConfigs.clear();
  for (const row of cmdLogRows) {
    cmdLogConfigs.set(row.guildId, row.channelId);
  }

  const ignoredRows = getModLogIgnoredChannels();
  ignoredChannels.clear();
  for (const row of ignoredRows) {
    if (!ignoredChannels.has(row.guildId)) ignoredChannels.set(row.guildId, new Set());
    ignoredChannels.get(row.guildId)!.add(row.channelId);
  }

  const cacheRows = getCachedMessages();
  messageCache.clear();
  for (const row of cacheRows) {
    messageCache.set(row.messageId, {
      authorId:         row.authorId,
      authorTag:        row.authorTag,
      authorAvatar:     row.authorAvatar,
      channelId:        row.channelId,
      guildId:          row.guildId,
      content:          row.content,
      createdTimestamp: row.createdTimestamp,
      attachments:      JSON.parse(row.attachments),
      replyToId:        row.replyToId ?? undefined,
    });
  }

  const mapRows = getLogMessageMap();
  logMessageMap.clear();
  for (const row of mapRows) {
    logMessageMap.set(row.messageId, row.logMessageId);
  }

  console.log(
    `📦 Loaded ${modLogConfigs.size} mod-log config(s), ` +
    `${cmdLogConfigs.size} command-log config(s), ` +
    `${messageCache.size} cached message(s) from database`,
  );
}

// ── Audit log permission check ────────────────────────────────

export async function checkAuditLogPermission(client: import('discord.js').Client): Promise<void> {
  for (const [guildId, config] of modLogConfigs) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;

    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember) continue;

    const hasPermission = botMember.permissions.has(PermissionFlagsBits.ViewAuditLog);

    const logChannel = await guild.channels.fetch(config.channelId).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) continue;

    if (!hasPermission) {
      await (logChannel as TextChannel).send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle('⚠️ Missing Permission: View Audit Log')
            .setDescription(
              'The bot is missing the **View Audit Log** permission.\n\n' +
              'Without it, deleted messages **cannot show who deleted them**.\n\n' +
              'To fix this: Server Settings → Roles → find the bot\'s role → enable **View Audit Log**.',
            )
            .setTimestamp(),
        ],
      });
    }
  }
}

// ── Slash command ─────────────────────────────────────────────

export const modLogCommand = new SlashCommandBuilder()
  .setName('modlog')
  .setDescription('Configure the mod-log channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set the mod-log channel (or auto-create one)')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel to log to (leave empty to auto-create)').setRequired(false),
      )
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role that can see it (used when auto-creating)').setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('remove').setDescription('Disable mod-log'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Show current mod-log config'))
  .addSubcommand((sub) =>
    sub
      .setName('ignore')
      .setDescription('Stop logging messages from a channel')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel to ignore').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unignore')
      .setDescription('Resume logging messages from a channel')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel to unignore').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('ignorelist').setDescription('List all channels excluded from logging'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('setcommandlog')
      .setDescription('Set a separate channel for command usage logs')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Channel to log commands to').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('removecommandlog').setDescription('Remove the separate command log channel (falls back to main mod-log)'),
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
    if (interaction.deferred) await interaction.editReply(reply);
    else await interaction.reply({ ...reply, ephemeral: true });
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
    const config   = modLogConfigs.get(interaction.guild.id);
    const cmdLogId = cmdLogConfigs.get(interaction.guild.id);
    const ignored  = ignoredChannels.get(interaction.guild.id);

    if (!config) {
      await interaction.reply({ content: 'ℹ️ Mod-log is not configured. Use `/modlog set` to enable it.', ephemeral: true });
      return;
    }

    const ignoredList = ignored && ignored.size > 0
      ? [...ignored].map((id) => `<#${id}>`).join(', ')
      : '*None*';

    const cmdLogLine = cmdLogId
      ? `\n⚙️ Command log channel: <#${cmdLogId}>`
      : `\n⚙️ Command log channel: *same as mod-log*`;

    await interaction.reply({
      content:
        `📋 Mod-log active → <#${config.channelId}>` +
        cmdLogLine +
        `\n🔇 Ignored channels: ${ignoredList}`,
      ephemeral: true,
    });
    return;
  }

  // /modlog ignore
  if (sub === 'ignore') {
    const channel = interaction.options.getChannel('channel', true);
    if (!ignoredChannels.has(interaction.guild.id)) ignoredChannels.set(interaction.guild.id, new Set());
    ignoredChannels.get(interaction.guild.id)!.add(channel.id);
    addModLogIgnoredChannel(interaction.guild.id, channel.id);
    await interaction.reply({ content: `🔇 <#${channel.id}> will no longer be logged.`, ephemeral: true });
    return;
  }

  // /modlog unignore
  if (sub === 'unignore') {
    const channel = interaction.options.getChannel('channel', true);
    ignoredChannels.get(interaction.guild.id)?.delete(channel.id);
    removeModLogIgnoredChannel(interaction.guild.id, channel.id);
    await interaction.reply({ content: `🔊 <#${channel.id}> will now be logged again.`, ephemeral: true });
    return;
  }

  // /modlog ignorelist
  if (sub === 'ignorelist') {
    const ignored = ignoredChannels.get(interaction.guild.id);
    if (!ignored || ignored.size === 0) {
      await interaction.reply({ content: 'ℹ️ No channels are currently ignored.', ephemeral: true });
      return;
    }
    const list = [...ignored].map((id) => `• <#${id}>`).join('\n');
    await interaction.reply({ content: `**Ignored channels (${ignored.size}):**\n${list}`, ephemeral: true });
    return;
  }

  // /modlog setcommandlog
  if (sub === 'setcommandlog') {
    const channel = interaction.options.getChannel('channel', true);
    cmdLogConfigs.set(interaction.guild.id, channel.id);
    saveCmdLogConfig(interaction.guild.id, channel.id);
    await interaction.reply({ content: `✅ Command log set to <#${channel.id}>.`, ephemeral: true });
    return;
  }

  // /modlog removecommandlog
  if (sub === 'removecommandlog') {
    cmdLogConfigs.delete(interaction.guild.id);
    deleteCmdLogConfig(interaction.guild.id);
    await interaction.reply({
      content: '🗑 Command log channel removed. Commands will now log to the main mod-log.',
      ephemeral: true,
    });
    return;
  }
}

// ── Build "sent" embed ────────────────────────────────────────

async function buildSentEmbed(message: Message): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('💬 Message Sent')
    .setTimestamp()
    .setFooter({ text: `Message ID: ${message.id}` })
    .setAuthor({ name: message.author.id, iconURL: message.author.displayAvatarURL() })
    .addFields(
      { name: 'Author',  value: `<@${message.author.id}>`, inline: true },
      { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
      { name: 'Sent',    value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`, inline: true },
    );

  if (message.reference?.messageId) {
    try {
      const repliedTo     = await message.channel.messages.fetch(message.reference.messageId);
      const repliedMember = await message.guild!.members.fetch(repliedTo.author.id);
      const replyContent  = repliedTo.content || '*No text content*';
      embed.addFields({
        name: `↩️ Replying to ${repliedMember.displayName}`,
        value: replyContent.length > 1024 ? replyContent.slice(0, 1021) + '...' : replyContent,
      });
    } catch {
      embed.addFields({ name: '↩️ Was a reply', value: '*Original message no longer available*' });
    }
  }

  embed.addFields({
    name: 'Content',
    value: message.content?.length > 0
      ? (message.content.length > 1024 ? message.content.slice(0, 1021) + '...' : message.content)
      : '*No text content*',
  });

  if (message.attachments.size > 0) {
    const list = message.attachments.map((a) => `[${a.name}](${a.url})`).join('\n');
    embed.addFields({ name: `Attachments (${message.attachments.size})`, value: list });
    const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (image) embed.setImage(image.url);
  }

  if (message.embeds?.length > 0) {
    for (const discordEmbed of message.embeds) {
      const image = discordEmbed.image?.url ?? discordEmbed.thumbnail?.url;
      if (image) {
        embed.setImage(image);
        if (discordEmbed.title) embed.addFields({ name: '🔗 ' + (discordEmbed.provider?.name ?? 'Link'), value: discordEmbed.title.slice(0, 1024) });
        break;
      }
    }
  }

  return embed;
}

// ── Build "deleted" embed from cache ─────────────────────────

async function buildDeletedEmbed(
  messageId: Snowflake,
  cached: CachedMessage,
  guild: NonNullable<Message['guild']>,
  logChannel: TextChannel,
): Promise<EmbedBuilder> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle('🗑 Message Deleted')
    .setTimestamp()
    .setFooter({ text: `Message ID: ${messageId}` })
    .setAuthor({ name: cached.authorId, iconURL: cached.authorAvatar })
    .addFields(
      { name: 'Author',  value: `<@${cached.authorId}>`, inline: true },
      { name: 'Channel', value: `<#${cached.channelId}>`, inline: true },
      { name: 'Sent',    value: `<t:${Math.floor(cached.createdTimestamp / 1000)}:F>`, inline: true },
    );

  if (cached.replyToId) {
    try {
      const ch        = await guild.channels.fetch(cached.channelId).catch(() => null);
      const repliedTo = ch?.isTextBased()
        ? await (ch as TextChannel).messages.fetch(cached.replyToId).catch(() => null)
        : null;
      if (repliedTo) {
        const repliedMember = await guild.members.fetch(repliedTo.author.id).catch(() => null);
        const displayName   = repliedMember?.displayName ?? repliedTo.author.tag;
        const replyContent  = repliedTo.content || '*No text content*';
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
    const list = cached.attachments.map((a) => `[${a.name}](${a.url})`).join('\n');
    embed.addFields({ name: `Attachments (${cached.attachments.length})`, value: list });
    const image = cached.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (image) embed.setImage(image.url);
  }

  return embed;
}

// ── Log message on send ───────────────────────────────────────

export async function logNewMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.guild) return;

  const config = modLogConfigs.get(message.guild.id);
  if (!config) return;

  if (message.channelId === config.channelId) return;
  if (ignoredChannels.get(message.guild.id)?.has(message.channelId)) return;

  try {
    const logChannel = await message.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const embed  = await buildSentEmbed(message);
    const logMsg = await (logChannel as TextChannel).send({
      embeds: [embed],
      components: [buildUserIdRow(message.author.id)],
    });

    logMessageMap.set(message.id, logMsg.id);
    saveLogMessageMap(message.id, logMsg.id);

    const cacheEntry: CachedMessage = {
      authorId:         message.author.id,
      authorTag:        message.author.tag,
      authorAvatar:     message.author.displayAvatarURL(),
      channelId:        message.channelId,
      guildId:          message.guild.id,
      content:          message.content ?? '',
      createdTimestamp: message.createdTimestamp,
      attachments:      message.attachments.map((a) => ({
        name: a.name, url: a.url, contentType: a.contentType ?? null,
      })),
      replyToId: message.reference?.messageId,
    };
    messageCache.set(message.id, cacheEntry);
    saveCachedMessage(message.id, cacheEntry);

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
  if (!logEntryId) return;

  try {
    const logChannel = await message.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const logEntry = await (logChannel as TextChannel).messages.fetch(logEntryId).catch(() => null);
    if (!logEntry) return;

    // Wait 1.5s for Discord's audit log to populate
    await new Promise((res) => setTimeout(res, 1500));

    // Check audit log for who deleted it
    let deletedBy: string | null = null;
    let deletedBySelf = false;
    try {
      const auditLogs = await message.guild.fetchAuditLogs({
        type: 72, // MESSAGE_DELETE
        limit: 5,
      });

      const entry = auditLogs.entries.find((e) => {
        const isRecent  = Date.now() - e.createdTimestamp < 5000;
        const isChannel = (e.extra as any)?.channel?.id === message.channelId;
        const isTarget  = e.target?.id === message.author?.id;
        return isRecent && isChannel && isTarget;
      });

      if (entry) {
        deletedBySelf = entry.executor?.id === message.author?.id;
        deletedBy     = entry.executor?.id ?? null;
      } else {
        deletedBySelf = true;
        deletedBy     = message.author?.id ?? null;
      }
    } catch {
      // Missing audit log permission — skip who-deleted info
    }

    const cached   = messageCache.get(message.id);
    const authorId = cached?.authorId ?? message.author?.id;

    let updatedEmbed: EmbedBuilder;

    if (cached) {
      updatedEmbed = await buildDeletedEmbed(message.id, cached, message.guild, logChannel as TextChannel);
    } else {
      updatedEmbed = new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle('🗑 Message Deleted')
        .setTimestamp()
        .setFooter({ text: `Message ID: ${message.id}` })
        .addFields(
          { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
          { name: 'Content', value: '*Content unavailable — message was sent before bot started*' },
        );
    }

    // Add who deleted it
    if (deletedBy) {
      if (deletedBySelf) {
        updatedEmbed.addFields({
          name: '🗑 Deleted By',
          value: `<@${deletedBy}> *(deleted their own message)*`,
        });
      } else {
        updatedEmbed
          .setColor(Colors.DarkRed)
          .setTitle('🛡 Message Deleted by Moderator')
          .addFields({
            name: '🛡 Deleted By Moderator',
            value: `<@${deletedBy}>`,
          });
      }
    }

    await logEntry.edit({
      embeds: [updatedEmbed],
      components: authorId ? [buildUserIdRow(authorId)] : [],
    });

    logMessageMap.delete(message.id);
    messageCache.delete(message.id);
    deleteLogMessageMap(message.id);
    deleteCachedMessage(message.id);
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
        { name: 'Channel',          value: `<#${channel.id}>`, inline: true },
        { name: 'Messages Deleted', value: `${messages.size}`, inline: true },
      );

    const preview = [...messages.values()]
      .filter((m): m is Message => !m.partial && !!m.author && !m.author.bot)
      .slice(0, 20)
      .map((m) => `**${m.author.id}**: ${m.content?.slice(0, 100) ?? '*no content*'}`)
      .join('\n');

    if (preview) {
      embed.addFields({
        name: 'Preview (up to 20)',
        value: preview.length > 1024 ? preview.slice(0, 1021) + '...' : preview,
      });
    }

    await (logChannel as TextChannel).send({ embeds: [embed] });

    for (const id of messages.keys()) {
      logMessageMap.delete(id);
      messageCache.delete(id);
      deleteLogMessageMap(id);
      deleteCachedMessage(id);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log bulk delete: ${msg}`);
  }
}

// ── Log edited message ────────────────────────────────────────

export async function logEditedMessage(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  if (!newMessage.guild) return;
  if (newMessage.author?.bot) return;

  const oldContent = oldMessage.partial ? null : oldMessage.content;
  const newContent = newMessage.partial ? null : newMessage.content;
  if (oldContent === newContent) return;

  const config = modLogConfigs.get(newMessage.guild.id);
  if (!config) return;

  if (ignoredChannels.get(newMessage.guild.id)?.has(newMessage.channelId)) return;

  try {
    const logChannel = await newMessage.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const full = newMessage.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;

    const embed = new EmbedBuilder()
      .setColor(Colors.Yellow)
      .setTitle('✏️ Message Edited')
      .setTimestamp()
      .setFooter({ text: `Message ID: ${newMessage.id}` });

    if (full?.author) {
      embed.setAuthor({
        name: full.author.id,
        iconURL: full.author.displayAvatarURL(),
      });
      embed.addFields(
        { name: 'Author',  value: `<@${full.author.id}>`, inline: true },
        { name: 'Channel', value: `<#${newMessage.channelId}>`, inline: true },
        { name: 'Sent',    value: `<t:${Math.floor(newMessage.createdTimestamp! / 1000)}:F>`, inline: true },
      );
    }

    const cached     = messageCache.get(newMessage.id);
    const beforeText = cached?.content ?? oldContent ?? '*Not available*';
    embed.addFields({
      name: 'Before',
      value: beforeText.length > 1024 ? beforeText.slice(0, 1021) + '...' : beforeText || '*Empty*',
    });

    const afterText = newContent ?? full?.content ?? '*Not available*';
    embed.addFields({
      name: 'After',
      value: afterText.length > 1024 ? afterText.slice(0, 1021) + '...' : afterText || '*Empty*',
    });

    embed.addFields({
      name: 'Jump to message',
      value: `[Click here](https://discord.com/channels/${newMessage.guild.id}/${newMessage.channelId}/${newMessage.id})`,
    });

    const authorId = full?.author?.id ?? cached?.authorId;

    await (logChannel as TextChannel).send({
      embeds: [embed],
      components: authorId ? [buildUserIdRow(authorId)] : [],
    });

    if (cached && newContent) {
      cached.content = newContent;
      messageCache.set(newMessage.id, cached);
      saveCachedMessage(newMessage.id, cached);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log edited message: ${msg}`);
  }
}

// ── Log member join ───────────────────────────────────────────

export async function logMemberJoin(member: GuildMember): Promise<void> {
  const config = modLogConfigs.get(member.guild.id);
  if (!config) return;

  try {
    const logChannel = await member.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const accountAge  = Date.now() - member.user.createdTimestamp;
    const accountDays = Math.floor(accountAge / 86_400_000);
    const isNew       = accountDays < 7;

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`${isNew ? '⚠️ ' : ''}👋 Member Joined`)
      .setAuthor({
        name: member.user.id,
        iconURL: member.user.displayAvatarURL(),
      })
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .setTimestamp()
      .setFooter({ text: `User ID: ${member.id}` })
      .addFields(
        { name: 'User',            value: `<@${member.id}>`, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Account Age',     value: `${accountDays} day${accountDays !== 1 ? 's' : ''}`, inline: true },
      );

    if (isNew) {
      embed.addFields({
        name: '⚠️ New Account',
        value: 'This account was created less than 7 days ago.',
      });
    }

    await (logChannel as TextChannel).send({
      embeds: [embed],
      components: [buildUserIdRow(member.id)],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log member join: ${msg}`);
  }
}

// ── Log member leave ──────────────────────────────────────────

export async function logMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  const config = modLogConfigs.get(member.guild.id);
  if (!config) return;

  try {
    const logChannel = await member.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const roles = member.roles.cache
      .filter((r) => r.id !== member.guild.id)
      .map((r) => `<@&${r.id}>`)
      .join(', ') || '*None*';

    const embed = new EmbedBuilder()
      .setColor(Colors.Grey)
      .setTitle('🚪 Member Left')
      .setAuthor({
        name: member.user?.id ?? member.id,
        iconURL: member.user?.displayAvatarURL(),
      })
      .setTimestamp()
      .setFooter({ text: `User ID: ${member.id}` })
      .addFields(
        { name: 'User',   value: `<@${member.id}>`, inline: true },
        { name: 'Joined', value: member.joinedAt
            ? `<t:${Math.floor(member.joinedTimestamp! / 1000)}:R>`
            : '*Unknown*',
          inline: true,
        },
        { name: 'Roles', value: roles.length > 1024 ? roles.slice(0, 1021) + '...' : roles },
      );

    await (logChannel as TextChannel).send({
      embeds: [embed],
      components: [buildUserIdRow(member.id)],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log member leave: ${msg}`);
  }
}

// ── Log role changes ──────────────────────────────────────────

export async function logRoleUpdate(
  oldMember: GuildMember | PartialGuildMember,
  newMember: GuildMember,
): Promise<void> {
  const config = modLogConfigs.get(newMember.guild.id);
  if (!config) return;

  const oldRoles = oldMember.roles.cache;
  const newRoles = newMember.roles.cache;

  const added   = newRoles.filter((r) => !oldRoles.has(r.id) && r.id !== newMember.guild.id);
  const removed = oldRoles.filter((r) => !newRoles.has(r.id) && r.id !== newMember.guild.id);

  if (added.size === 0 && removed.size === 0) return;

  try {
    const logChannel = await newMember.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle('🏷️ Roles Updated')
      .setAuthor({
        name: newMember.user.id,
        iconURL: newMember.user.displayAvatarURL(),
      })
      .setTimestamp()
      .setFooter({ text: `User ID: ${newMember.id}` })
      .addFields(
        { name: 'Member', value: `<@${newMember.id}>`, inline: true },
      );

    if (added.size > 0) {
      embed.addFields({
        name: `✅ Roles Added (${added.size})`,
        value: added.map((r) => `<@&${r.id}>`).join(', '),
      });
    }

    if (removed.size > 0) {
      embed.addFields({
        name: `❌ Roles Removed (${removed.size})`,
        value: removed.map((r) => `<@&${r.id}>`).join(', '),
      });
    }

    await (logChannel as TextChannel).send({
      embeds: [embed],
      components: [buildUserIdRow(newMember.id)],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log role update: ${msg}`);
  }
}

// ── Log command usage ─────────────────────────────────────────

export async function logCommandUsage(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) return;

  const channelId = cmdLogConfigs.get(interaction.guild.id)
    ?? modLogConfigs.get(interaction.guild.id)?.channelId;
  if (!channelId) return;

  if (interaction.channelId && ignoredChannels.get(interaction.guild.id)?.has(interaction.channelId)) return;

  try {
    const logChannel = await interaction.guild.channels.fetch(channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const options = interaction.options.data.map((opt) => {
      const value = opt.value ?? (opt.channel ? `#${opt.channel.name}` : opt.role ? `@${opt.role.name}` : opt.user?.tag);
      return `\`${opt.name}\`: ${value}`;
    }).join('\n') || '*No options*';

    const embed = new EmbedBuilder()
      .setColor(Colors.Purple)
      .setTitle('⚙️ Command Used')
      .setAuthor({
        name: interaction.user.id,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp()
      .setFooter({ text: `Interaction ID: ${interaction.id}` })
      .addFields(
        { name: 'User',    value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Channel', value: interaction.channelId ? `<#${interaction.channelId}>` : '*Unknown*', inline: true },
        { name: 'Command', value: `\`/${interaction.commandName}${interaction.options.getSubcommand(false) ? ' ' + interaction.options.getSubcommand() : ''}\``, inline: true },
        { name: 'Options', value: options },
      );

    await (logChannel as TextChannel).send({
      embeds: [embed],
      components: [buildUserIdRow(interaction.user.id)],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log command usage: ${msg}`);
  }
}
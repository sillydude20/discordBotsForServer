// src/features/modlog.ts
// ─────────────────────────────────────────────────────────────
// Commands:
//   /modlog set             — set/create the mod-log channel
//   /modlog remove          — disable mod-log
//   /modlog status          — show current config
//   /modlog ignore #channel — stop logging messages from a channel
//   /modlog unignore #channel
//   /modlog ignorelist      — show all ignored channels
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
} from '../utils/database';

// ── Types ─────────────────────────────────────────────────────

interface ModLogConfig {
  guildId: string;
  channelId: string;
}

// ── In-memory stores (all loaded from DB on startup) ──────────

const modLogConfigs    = new Map<string, ModLogConfig>();   // guildId → config
const ignoredChannels  = new Map<string, Set<string>>();    // guildId → Set<channelId>
const logMessageMap    = new Map<Snowflake, Snowflake>();   // originalMsgId → logMsgId
const messageCache     = new Map<Snowflake, CachedMessage>(); // msgId → content

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

// ── Load everything from DB on startup ───────────────────────

export function loadModLogConfigs(): void {
  // Configs
  const configRows = getModLogConfig();
  modLogConfigs.clear();
  for (const row of configRows) {
    modLogConfigs.set(row.guildId, { guildId: row.guildId, channelId: row.channelId });
  }

  // Ignored channels
  const ignoredRows = getModLogIgnoredChannels();
  ignoredChannels.clear();
  for (const row of ignoredRows) {
    if (!ignoredChannels.has(row.guildId)) ignoredChannels.set(row.guildId, new Set());
    ignoredChannels.get(row.guildId)!.add(row.channelId);
  }

  // Message cache (content stored between restarts)
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

  // Log message map (originalId → logId)
  const mapRows = getLogMessageMap();
  logMessageMap.clear();
  for (const row of mapRows) {
    logMessageMap.set(row.messageId, row.logMessageId);
  }

  console.log(
    `📦 Loaded ${modLogConfigs.size} mod-log config(s), ` +
    `${messageCache.size} cached message(s) from database`,
  );
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
    const config  = modLogConfigs.get(interaction.guild.id);
    const ignored = ignoredChannels.get(interaction.guild.id);

    if (!config) {
      await interaction.reply({ content: 'ℹ️ Mod-log is not configured. Use `/modlog set` to enable it.', ephemeral: true });
      return;
    }

    const ignoredList = ignored && ignored.size > 0
      ? [...ignored].map((id) => `<#${id}>`).join(', ')
      : '*None*';

    await interaction.reply({
      content: `📋 Mod-log active → <#${config.channelId}>\n🔇 Ignored channels: ${ignoredList}`,
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
      const repliedTo    = await message.channel.messages.fetch(message.reference.messageId);
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
      const ch = await guild.channels.fetch(cached.channelId).catch(() => null);
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

  // Skip mod-log channel itself and any ignored channels
  if (message.channelId === config.channelId) return;
  if (ignoredChannels.get(message.guild.id)?.has(message.channelId)) return;

  try {
    const logChannel = await message.guild.channels.fetch(config.channelId);
    if (!logChannel || !logChannel.isTextBased()) return;

    const embed  = await buildSentEmbed(message);
    const logMsg = await (logChannel as TextChannel).send({ embeds: [embed] });

    // Persist both the log map and the message cache to DB
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

    // Evict oldest in-memory entry if over limit
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

    const cached = messageCache.get(message.id);

    if (cached) {
      const updatedEmbed = await buildDeletedEmbed(
        message.id,
        cached,
        message.guild,
        logChannel as TextChannel,
      );
      await logEntry.edit({ embeds: [updatedEmbed] });
    } else {
      // Fallback: sent before bot started, no cache available
      const embed = new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle('🗑 Message Deleted')
        .setTimestamp()
        .setFooter({ text: `Message ID: ${message.id}` })
        .addFields(
          { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
          { name: 'Content', value: '*Content unavailable — message was sent before bot started*' },
        );
      await logEntry.edit({ embeds: [embed] });
    }

    // Clean up memory and DB
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

    // Clean up
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

  // Only log if content actually changed
  const oldContent = oldMessage.partial ? null : oldMessage.content;
  const newContent = newMessage.partial ? null : newMessage.content;
  if (oldContent === newContent) return;

  const config = modLogConfigs.get(newMessage.guild.id);
  if (!config) return;

  // Skip ignored channels
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

    // Before — pull from our cache if available, otherwise show what we have
    const cached = messageCache.get(newMessage.id);
    const beforeText = cached?.content ?? oldContent ?? '*Not available*';
    embed.addFields({
      name: 'Before',
      value: beforeText.length > 1024 ? beforeText.slice(0, 1021) + '...' : beforeText || '*Empty*',
    });

    // After
    const afterText = newContent ?? full?.content ?? '*Not available*';
    embed.addFields({
      name: 'After',
      value: afterText.length > 1024 ? afterText.slice(0, 1021) + '...' : afterText || '*Empty*',
    });

    // Jump link
    embed.addFields({
      name: 'Jump to message',
      value: `[Click here](https://discord.com/channels/${newMessage.guild.id}/${newMessage.channelId}/${newMessage.id})`,
    });

    await (logChannel as TextChannel).send({ embeds: [embed] });

    // Update cache with new content
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
        { name: 'User',           value: `<@${member.id}>`, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Account Age',    value: `${accountDays} day${accountDays !== 1 ? 's' : ''}`, inline: true },
      );

    if (isNew) {
      embed.addFields({
        name: '⚠️ New Account',
        value: 'This account was created less than 7 days ago.',
      });
    }

    await (logChannel as TextChannel).send({ embeds: [embed] });
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
      .filter((r) => r.id !== member.guild.id) // exclude @everyone
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

    await (logChannel as TextChannel).send({ embeds: [embed] });
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

  // Find roles added/removed
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

    await (logChannel as TextChannel).send({ embeds: [embed] });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[modlog] Failed to log role update: ${msg}`);
  }
}
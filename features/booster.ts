// src/features/booster.ts
// ─────────────────────────────────────────────────────────────
// Booster perks:
//   • Personal role with custom color + icon
//   • Showcase channel card showing profile pic + boost duration
//     — card is posted when they start boosting
//     — card is deleted when they stop
//     — card updates every time they change their color/icon
//
// Booster commands:
//   /booster color <hex>
//   /booster icon emoji <emoji>
//   /booster icon url <url>
//   /booster icon clear
//   /booster reset
//
// Admin commands:
//   /boosteradmin setup               — set the showcase channel
//   /boosteradmin clear @user         — remove a user's booster role + card
//   /boosteradmin list                — list all active boosters
// ─────────────────────────────────────────────────────────────

import {
  Client,
  ChatInputCommandInteraction,
  GuildMember,
  Role,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Guild,
  EmbedBuilder,
  Colors,
  TextChannel,
  Snowflake,
} from 'discord.js';
import {
  getBoosterRole,
  saveBoosterRole,
  deleteBoosterRole,
  getAllBoosterRoles,
  getBoosterShowcaseChannel,
  saveBoosterShowcaseChannel,
  getBoosterCard,
  saveBoosterCard,
  deleteBoosterCard,
} from '../utils/database';

// ── Slash commands ────────────────────────────────────────────

export const boosterCommand = new SlashCommandBuilder()
  .setName('booster')
  .setDescription('Customize your booster role (server boosters only)')
  .addSubcommand((sub) =>
    sub
      .setName('color')
      .setDescription('Set your role color')
      .addStringOption((opt) =>
        opt.setName('hex').setDescription('Hex color e.g. #ff00ff').setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('icon')
      .setDescription('Set your role icon')
      .addSubcommand((sub) =>
        sub
          .setName('emoji')
          .setDescription('Use a server emoji as your role icon')
          .addStringOption((opt) =>
            opt.setName('emoji').setDescription('A custom server emoji').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('url')
          .setDescription('Use an image URL as your role icon')
          .addStringOption((opt) =>
            opt.setName('url').setDescription('Direct image URL (png/jpg/gif)').setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('upload')
          .setDescription('Upload an image file as your role icon')
          .addAttachmentOption((opt) =>
            opt
              .setName('image')
              .setDescription('Image file to use (png/jpg/gif, under 256kb)')
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('clear').setDescription('Remove your role icon')),
  )
  .addSubcommand((sub) =>
    sub.setName('reset').setDescription('Reset your role color to default'),
  );

export const boosterAdminCommand = new SlashCommandBuilder()
  .setName('boosteradmin')
  .setDescription('Admin tools for booster roles')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Set the channel where booster cards are posted')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Showcase channel').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription("Remove a user's booster role and card")
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The user').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List all active booster roles'),
  );

// ── Helpers ───────────────────────────────────────────────────

function parseHex(input: string): number | null {
  const cleaned = input.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  return parseInt(cleaned, 16);
}

function isBoosting(member: GuildMember): boolean {
  return !!member.premiumSince;
}

function getBotHighestRolePosition(guild: Guild, botId: string): number {
  const botMember = guild.members.cache.get(botId);
  if (!botMember) return 0;
  return botMember.roles.highest.position;
}

// Finds the position just above the Server Booster role (or just below the bot's highest role as fallback)
function getIdealBoosterRolePosition(guild: Guild, botId: string): number {
  // Look for Discord's built-in Server Booster role (it has the PREMIUM_SUBSCRIBER tag)
  const boosterRole = guild.roles.cache.find(
    (r) => r.tags?.premiumSubscriberRole === true,
  );

  if (boosterRole) {
    // Place perk role one step above the Server Booster role
    // but never above the bot's own highest role
    const botPosition = getBotHighestRolePosition(guild, botId);
    const targetPosition = boosterRole.position + 1;
    return Math.min(targetPosition, botPosition - 1);
  }

  // Fallback: just below the bot's highest role
  return Math.max(1, getBotHighestRolePosition(guild, botId) - 1);
}

function formatDuration(since: Date): string {
  const now    = Date.now();
  const diffMs = now - since.getTime();
  const days   = Math.floor(diffMs / 86_400_000);
  const months = Math.floor(days / 30);
  const years  = Math.floor(days / 365);

  if (years > 0)   return `${years} year${years  > 1 ? 's' : ''}`;
  if (months > 0)  return `${months} month${months > 1 ? 's' : ''}`;
  if (days > 0)    return `${days} day${days > 1 ? 's' : ''}`;
  return 'Just started!';
}

// ── Personal booster role ─────────────────────────────────────

async function getOrCreateBoosterRole(
  member: GuildMember,
  client: Client,
): Promise<Role> {
  const existing = getBoosterRole(member.guild.id, member.id);

  if (existing) {
    const role = member.guild.roles.cache.get(existing.roleId)
      ?? await member.guild.roles.fetch(existing.roleId).catch(() => null);
    if (role) return role;
    deleteBoosterRole(member.guild.id, member.id);
  }

  const position = getIdealBoosterRolePosition(member.guild, client.user!.id);
  const role = await member.guild.roles.create({
    name: `${member.displayName}'s color`,
    color: 0x000000,
    hoist: false,
    mentionable: false,
    position,
    reason: `Booster perk role for ${member.user.tag}`,
  });

  await member.roles.add(role, 'Booster perk role assigned');
  saveBoosterRole(member.guild.id, member.id, role.id);
  return role;
}

// ── Showcase card ─────────────────────────────────────────────

async function buildBoosterEmbed(member: GuildMember, role?: Role | null): Promise<EmbedBuilder> {
  const since    = member.premiumSince!;
  const duration = formatDuration(since);
  const color    = role?.color ?? Colors.Gold;

  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: `💎 ${member.displayName} is boosting!`,
      iconURL: member.displayAvatarURL({ size: 128 }),
    })
    .setThumbnail(member.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '👤 Member',        value: `<@${member.id}>`, inline: true },
      { name: '📅 Boosting since', value: `<t:${Math.floor(since.getTime() / 1000)}:D>`, inline: true },
      { name: '⏱ Duration',        value: duration, inline: true },
    )
    .setFooter({ text: 'Thank you for boosting! 💖' })
    .setTimestamp(since);
}

// Posts or updates the booster's showcase card
async function upsertBoosterCard(
  member: GuildMember,
  client: Client,
  role?: Role | null,
): Promise<void> {
  const channelId = getBoosterShowcaseChannel(member.guild.id);
  if (!channelId) return;

  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const embed      = await buildBoosterEmbed(member, role);
  const existingId = getBoosterCard(member.guild.id, member.id);

  if (existingId) {
    // Try to edit the existing card
    const existing = await (channel as TextChannel).messages.fetch(existingId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
    // Message was deleted — fall through to re-post
    deleteBoosterCard(member.guild.id, member.id);
  }

  // Post a new card
  const sent = await (channel as TextChannel).send({ embeds: [embed] });
  saveBoosterCard(member.guild.id, member.id, sent.id);
}

// Deletes the booster's showcase card
async function removeBoosterCard(
  member: GuildMember,
  guild: Guild,
): Promise<void> {
  const channelId = getBoosterShowcaseChannel(guild.id);
  if (!channelId) return;

  const cardMsgId = getBoosterCard(guild.id, member.id);
  if (!cardMsgId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) {
    const msg = await (channel as TextChannel).messages.fetch(cardMsgId).catch(() => null);
    if (msg) await msg.delete().catch(() => null);
  }

  deleteBoosterCard(guild.id, member.id);
}

// ── Booster command handler ───────────────────────────────────

export async function handleBoosterInteraction(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  if (interaction.commandName !== 'booster') return;
  if (!interaction.guild || !interaction.member) return;

  const member = interaction.member as GuildMember;

  if (!isBoosting(member)) {
    await interaction.reply({
      content: '❌ This command is only available to server boosters.',
      ephemeral: true,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub   = interaction.options.getSubcommand();

  await interaction.deferReply({ ephemeral: true });

  try {
    const role = await getOrCreateBoosterRole(member, client);

    // /booster color
    if (sub === 'color' && !group) {
      const hex   = interaction.options.getString('hex', true);
      const color = parseHex(hex);
      if (color === null) {
        await interaction.editReply({ content: '❌ Invalid hex color. Use a format like `#ff00ff`.' });
        return;
      }
      await role.setColor(color, 'Booster set custom color');
      await upsertBoosterCard(member, client, role);
      await interaction.editReply({
        content: `✅ Color set to **#${color.toString(16).padStart(6, '0').toUpperCase()}** and your showcase card has been updated.`,
      });
      return;
    }

    // /booster reset
    if (sub === 'reset') {
      await role.setColor(0x000000, 'Booster reset color');
      await upsertBoosterCard(member, client, role);
      await interaction.editReply({ content: '✅ Color reset to default and showcase card updated.' });
      return;
    }

    // /booster icon emoji
    if (group === 'icon' && sub === 'emoji') {
      if (!interaction.guild.features.includes('ROLE_ICONS')) {
        await interaction.editReply({ content: '❌ Role icons require **Boost Level 2** or higher.' });
        return;
      }
      const emojiInput = interaction.options.getString('emoji', true).trim();
      const fullMatch  = emojiInput.match(/^<(a?):(\w+):(\d+)>$/);
      let resolvedEmoji: string;

      if (fullMatch) {
        resolvedEmoji = emojiInput;
      } else {
        const nameMatch = emojiInput.match(/^:?(\w+):?$/);
        const found = nameMatch
          ? interaction.guild.emojis.cache.find((e) => e.name === nameMatch[1])
          : null;
        if (!found) {
          await interaction.editReply({ content: '❌ Could not find that emoji in this server.' });
          return;
        }
        resolvedEmoji = found.toString();
      }

      await role.setUnicodeEmoji(resolvedEmoji).catch(() =>
        role.edit({ icon: resolvedEmoji }),
      );
      await upsertBoosterCard(member, client, role);
      await interaction.editReply({ content: `✅ Role icon set to ${resolvedEmoji}.` });
      return;
    }

    // /booster icon url
    if (group === 'icon' && sub === 'url') {
      if (!interaction.guild.features.includes('ROLE_ICONS')) {
        await interaction.editReply({ content: '❌ Role icons require **Boost Level 2** or higher.' });
        return;
      }
      const url = interaction.options.getString('url', true).trim();
      if (!/^https?:\/\//i.test(url)) {
        await interaction.editReply({ content: '❌ Please provide a valid image URL starting with `https://`.' });
        return;
      }
      // Validate the URL actually serves an image by checking Content-Type
      try {
        const res = await fetch(url, { method: 'HEAD' });
        const ct  = res.headers.get('content-type') ?? '';
        if (!ct.startsWith('image/')) {
          await interaction.editReply({ content: '❌ That URL does not appear to serve an image. Make sure it is a direct link to a `.png`, `.jpg`, `.gif`, or `.webp` file.' });
          return;
        }
      } catch {
        await interaction.editReply({ content: '❌ Could not reach that URL. Make sure it is a publicly accessible direct image link.' });
        return;
      }
      await role.edit({ icon: url });
      await upsertBoosterCard(member, client, role);
      await interaction.editReply({ content: '✅ Role icon updated.' });
      return;
    }

    // /booster icon upload
    if (group === 'icon' && sub === 'upload') {
      if (!interaction.guild.features.includes('ROLE_ICONS')) {
        await interaction.editReply({ content: '❌ Role icons require **Boost Level 2** or higher.' });
        return;
      }
      const attachment = interaction.options.getAttachment('image', true);

      // Validate it's an image
      const ct = attachment.contentType ?? '';
      if (!ct.startsWith('image/')) {
        await interaction.editReply({ content: '❌ That file is not an image. Please upload a `.png`, `.jpg`, `.gif`, or `.webp` file.' });
        return;
      }

      // Discord role icons must be under 256kb
      if (attachment.size > 256 * 1024) {
        await interaction.editReply({ content: `❌ Image is too large (${Math.round(attachment.size / 1024)}kb). Role icons must be under **256kb**.` });
        return;
      }

      await role.edit({ icon: attachment.url, reason: 'Booster uploaded role icon' });
      await upsertBoosterCard(member, client, role);
      await interaction.editReply({ content: `✅ Role icon set from your uploaded image.` });
      return;
    }

    // /booster icon clear
    if (group === 'icon' && sub === 'clear') {
      await role.edit({ icon: null, unicodeEmoji: null });
      await upsertBoosterCard(member, client, role);
      await interaction.editReply({ content: '✅ Role icon removed.' });
      return;
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply({ content: `❌ Something went wrong: ${msg}` });
  }
}

// ── Admin command handler ─────────────────────────────────────

export async function handleBoosterAdminInteraction(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  if (interaction.commandName !== 'boosteradmin') return;
  if (!interaction.guild) return;

  const sub = interaction.options.getSubcommand();

  // /boosteradmin setup
  if (sub === 'setup') {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel('channel', true);
    saveBoosterShowcaseChannel(interaction.guild.id, channel.id);

    // Reposition ALL existing booster perk roles above the Server Booster role
    const targetPosition = getIdealBoosterRolePosition(interaction.guild, client.user!.id);
    const rows = getAllBoosterRoles(interaction.guild.id);
    let repositioned = 0;

    for (const row of rows) {
      const role = interaction.guild.roles.cache.get(row.roleId)
        ?? await interaction.guild.roles.fetch(row.roleId).catch(() => null);
      if (role && role.position !== targetPosition) {
        await role.setPosition(targetPosition, { reason: 'Repositioning booster role above Server Booster' })
          .catch(() => null);
        repositioned++;
      }
    }

    const repoNote = rows.length > 0
      ? `\n📐 Repositioned **${repositioned}/${rows.length}** existing booster role(s) above the Server Booster role.`
      : '';

    await interaction.editReply({
      content: `✅ Booster showcase channel set to <#${channel.id}>.${repoNote}\n\nNew booster roles will automatically be placed above the Server Booster role so colors show on names.`,
    });
    return;
  }

  // /boosteradmin clear @user
  if (sub === 'clear') {
    await interaction.deferReply({ ephemeral: true });

    const user   = interaction.options.getUser('user', true);
    const stored = getBoosterRole(interaction.guild.id, user.id);

    if (!stored) {
      await interaction.editReply({ content: `ℹ️ ${user.tag} doesn't have a booster role on record.` });
      return;
    }

    // Delete the perk role
    const role = interaction.guild.roles.cache.get(stored.roleId)
      ?? await interaction.guild.roles.fetch(stored.roleId).catch(() => null);
    if (role) await role.delete('Admin cleared booster role').catch(() => null);
    deleteBoosterRole(interaction.guild.id, user.id);

    // Delete the showcase card
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (member) await removeBoosterCard(member, interaction.guild);

    await interaction.editReply({ content: `✅ Removed booster role and card for **${user.tag}**.` });
    return;
  }

  // /boosteradmin list
  if (sub === 'list') {
    const rows = getAllBoosterRoles(interaction.guild.id);
    if (!rows.length) {
      await interaction.reply({ content: 'ℹ️ No booster roles have been created yet.', ephemeral: true });
      return;
    }
    const lines = rows.map((r) => `• <@${r.userId}> → <@&${r.roleId}>`);
    await interaction.reply({
      content: `**Active boosters (${rows.length}):**\n${lines.join('\n')}`,
      ephemeral: true,
    });
  }
}

// ── Boost start / stop detection ─────────────────────────────

export async function handleBoostChange(
  oldMember: GuildMember,
  newMember: GuildMember,
  client: Client,
): Promise<void> {
  const wasBoosting = !!oldMember.premiumSince;
  const nowBoosting = !!newMember.premiumSince;

  // Started boosting — post the showcase card
  if (!wasBoosting && nowBoosting) {
    // Give Discord a moment to fully register the boost
    await new Promise((r) => setTimeout(r, 2_000));
    const freshMember = await newMember.guild.members.fetch(newMember.id).catch(() => newMember);
    await upsertBoosterCard(freshMember, client, null);
    console.log(`💎 ${newMember.user.tag} started boosting — card posted`);
  }

  // Stopped boosting — delete role + card
  if (wasBoosting && !nowBoosting) {
    const stored = getBoosterRole(newMember.guild.id, newMember.id);
    if (stored) {
      const role = newMember.guild.roles.cache.get(stored.roleId)
        ?? await newMember.guild.roles.fetch(stored.roleId).catch(() => null);
      if (role) await role.delete('User stopped boosting').catch(() => null);
      deleteBoosterRole(newMember.guild.id, newMember.id);
    }

    await removeBoosterCard(newMember, newMember.guild);
    console.log(`💔 ${newMember.user.tag} stopped boosting — card removed`);
  }
}
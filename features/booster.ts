// src/features/booster.ts
// ─────────────────────────────────────────────────────────────
// Booster perks:
//   • Personal role with custom name, color + icon
//   • Showcase channel card showing profile pic + boost duration
//     — card is posted when they start boosting
//     — card is deleted when they stop
//     — card updates every time they change their color/icon
//
// Booster commands:
//   /booster setup                    — guided multi-step role setup
//   /booster color <hex>
//   /booster icon emoji <emoji>
//   /booster icon url <url>
//   /booster icon upload <image>
//   /booster icon clear
//   /booster reset
//
// Admin commands:
//   /boosteradmin setup               — set the showcase channel
//   /boosteradmin clear @user         — remove a user's booster role + card
//   /boosteradmin list                — list all active boosters
//   /boosteradmin sync                — audit all boosters, fix missing roles/cards
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
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonInteraction,
  ModalSubmitInteraction,
  ComponentType,
  InteractionCollector,
  Message,
  ReadonlyCollection,
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
      .setName('setup')
      .setDescription('Guided setup to configure your booster role name, color, and icon'),
  )
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
    sub
      .setName('sync')
      .setDescription('Audit all boosters — create missing roles/cards, prune stale records')
      .addBooleanOption((opt) =>
        opt
          .setName('prune')
          .setDescription('Also remove roles/cards for users who stopped boosting (default: true)')
          .setRequired(false),
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

function getIdealBoosterRolePosition(guild: Guild, botId: string): number {
  const boosterRole = guild.roles.cache.find(
    (r) => r.tags?.premiumSubscriberRole === true,
  );
  if (boosterRole) {
    const botPosition    = getBotHighestRolePosition(guild, botId);
    const targetPosition = boosterRole.position + 1;
    return Math.min(targetPosition, botPosition - 1);
  }
  return Math.max(1, getBotHighestRolePosition(guild, botId) - 1);
}

function formatDuration(since: Date): string {
  const now    = Date.now();
  const diffMs = now - since.getTime();
  const days   = Math.floor(diffMs / 86_400_000);
  const months = Math.floor(days / 30);
  const years  = Math.floor(days / 365);

  if (years > 0)  return `${years} year${years  > 1 ? 's' : ''}`;
  if (months > 0) return `${months} month${months > 1 ? 's' : ''}`;
  if (days > 0)   return `${days} day${days > 1 ? 's' : ''}`;
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
      { name: '👤 Member',         value: `<@${member.id}>`,                             inline: true },
      { name: '📅 Boosting since', value: `<t:${Math.floor(since.getTime() / 1000)}:D>`, inline: true },
      { name: '⏱ Duration',        value: duration,                                       inline: true },
    )
    .setFooter({ text: 'Thank you for boosting! 💖' })
    .setTimestamp(since);
}

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
    const existing = await (channel as TextChannel).messages.fetch(existingId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
    deleteBoosterCard(member.guild.id, member.id);
  }

  const sent = await (channel as TextChannel).send({ embeds: [embed] });
  saveBoosterCard(member.guild.id, member.id, sent.id);
}

async function removeBoosterCard(member: GuildMember, guild: Guild): Promise<void> {
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

// ── Guided setup flow ─────────────────────────────────────────

interface SetupState {
  name:  string | null;
  color: number | null;
  icon:  string | null; // emoji string, image URL, or null
}

// In-memory session store — one entry per user while setup is active
const setupSessions = new Map<string, SetupState>();

function buildSetupEmbed(
  member: GuildMember,
  state: SetupState,
  step: 'name' | 'color' | 'icon' | 'done',
): EmbedBuilder {
  const stepTitles = {
    name:  '📝 Step 1 of 3 — Role Name',
    color: '🎨 Step 2 of 3 — Role Color',
    icon:  '🖼 Step 3 of 3 — Role Icon',
    done:  '✅ Setup Complete',
  };

  const nameVal  = state.name  ?? '*Not set yet*';
  const colorVal = state.color != null
    ? `#${state.color.toString(16).padStart(6, '0').toUpperCase()}`
    : '*Not set yet*';
  const iconVal  = state.icon  ?? '*None*';

  const descriptions: Record<typeof step, string> = {
    name:  'Click the button below to set your **role name**.\nThis is what will appear in the member list.',
    color: 'Click the button below to set your **role color** using a hex code (e.g. `#ff00ff`).',
    icon:  'Choose how you want to set your **role icon**, or skip this step.\n*(Role icons require Boost Level 2)*',
    done:  'Your booster role has been saved! Run `/booster setup` any time to change it.',
  };

  return new EmbedBuilder()
    .setTitle(stepTitles[step])
    .setColor(state.color ?? Colors.Gold)
    .setThumbnail(member.displayAvatarURL({ size: 256 }))
    .setDescription(descriptions[step])
    .addFields(
      { name: '📝 Name',  value: nameVal,  inline: true },
      { name: '🎨 Color', value: colorVal, inline: true },
      { name: '🖼 Icon',  value: iconVal,  inline: true },
    );
}

function makeNameRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('booster_setup_name')
      .setLabel('Set Role Name')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary),
  );
}

function makeColorRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('booster_setup_color')
      .setLabel('Set Role Color')
      .setEmoji('🎨')
      .setStyle(ButtonStyle.Primary),
  );
}

function makeIconRow(hasRoleIcons: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('booster_setup_icon_emoji')
      .setLabel('Use Emoji')
      .setEmoji('😄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasRoleIcons),
    new ButtonBuilder()
      .setCustomId('booster_setup_icon_url')
      .setLabel('Use Image URL')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasRoleIcons),
    new ButtonBuilder()
      .setCustomId('booster_setup_icon_upload')
      .setLabel('Upload Image')
      .setEmoji('📁')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasRoleIcons),
    new ButtonBuilder()
      .setCustomId('booster_setup_icon_skip')
      .setLabel('Skip')
      .setStyle(ButtonStyle.Danger),
  );
}

async function applyRoleChanges(
  member: GuildMember,
  client: Client,
  state: SetupState,
): Promise<Role> {
  const role   = await getOrCreateBoosterRole(member, client);
  const edits: Parameters<Role['edit']>[0] = {};

  if (state.name  != null) edits.name  = state.name;
  if (state.color != null) edits.color = state.color;

  if (state.icon != null) {
    const customEmojiMatch = state.icon.match(/^<a?:\w+:(\d+)>$/);
    if (customEmojiMatch) {
      // Custom server emoji — pass its CDN image URL as the role icon
      edits.icon = `https://cdn.discordapp.com/emojis/${customEmojiMatch[1]}.png`;
    } else {
      edits.icon = state.icon;
    }
  }

  if (Object.keys(edits).length > 0) {
    await role.edit({ ...edits, reason: 'Booster guided setup' });
  }

  return role;
}

async function finishSetup(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  member: GuildMember,
  client: Client,
  state: SetupState,
  collector: InteractionCollector<ButtonInteraction>,
): Promise<void> {
  const role = await applyRoleChanges(member, client, state);
  await upsertBoosterCard(member, client, role);
  setupSessions.delete(member.id);
  collector.stop('done');

  // ModalSubmitInteraction has no .update() — defer then edit the original reply
  if (interaction.isModalSubmit()) {
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds:     [buildSetupEmbed(member, state, 'done')],
      components: [],
    });
  } else {
    await (interaction as ButtonInteraction).update({
      embeds:     [buildSetupEmbed(member, state, 'done')],
      components: [],
    });
  }
}

export async function handleBoosterSetup(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  const member = interaction.member as GuildMember;
  const guild  = interaction.guild!;
  const userId = member.id;

  // Pre-fill state from existing role if present
  const existingRecord = getBoosterRole(guild.id, userId);
  const existingRole   = existingRecord
    ? (guild.roles.cache.get(existingRecord.roleId)
        ?? await guild.roles.fetch(existingRecord.roleId).catch(() => null))
    : null;

  const state: SetupState = {
    name:  existingRole?.name  ?? null,
    color: existingRole?.color ?? null,
    icon:  null,
  };
  setupSessions.set(userId, state);

  const hasRoleIcons = guild.features.includes('ROLE_ICONS');

  await interaction.reply({
    embeds:     [buildSetupEmbed(member, state, 'name')],
    components: [makeNameRow()],
    ephemeral:  true,
  });

  const collector = interaction.channel!.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000, // 5 min timeout
    filter: (i) => i.user.id === userId && i.customId.startsWith('booster_setup'),
  });

  collector.on('collect', async (btn: ButtonInteraction) => {
    const s = setupSessions.get(userId);
    if (!s) return;

    // ── Step 1: Name ─────────────────────────────────────────
    if (btn.customId === 'booster_setup_name') {
      const modal = new ModalBuilder()
        .setCustomId('booster_modal_name')
        .setTitle('Set Your Role Name')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('role_name')
              .setLabel('Role name (max 32 characters)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(32)
              .setRequired(true)
              .setValue(s.name ?? `${member.displayName}'s color`),
          ),
        );

      await btn.showModal(modal);

      const submitted = await btn.awaitModalSubmit({
        filter: (m) => m.customId === 'booster_modal_name' && m.user.id === userId,
        time: 60_000,
      }).catch(() => null);

      if (!submitted) return;

      s.name = submitted.fields.getTextInputValue('role_name').trim()
        || `${member.displayName}'s color`;
      setupSessions.set(userId, s);

      await submitted.deferUpdate();
      await submitted.editReply({
        embeds:     [buildSetupEmbed(member, s, 'color')],
        components: [makeColorRow()],
      });
      return;
    }

    // ── Step 2: Color ────────────────────────────────────────
    if (btn.customId === 'booster_setup_color') {
      const modal = new ModalBuilder()
        .setCustomId('booster_modal_color')
        .setTitle('Set Your Role Color')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('role_color')
              .setLabel('Hex color (e.g. #ff00ff)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(7)
              .setRequired(true)
              .setValue(
                s.color != null
                  ? `#${s.color.toString(16).padStart(6, '0').toUpperCase()}`
                  : '#',
              ),
          ),
        );

      await btn.showModal(modal);

      const submitted = await btn.awaitModalSubmit({
        filter: (m) => m.customId === 'booster_modal_color' && m.user.id === userId,
        time: 60_000,
      }).catch(() => null);

      if (!submitted) return;

      const parsed = parseHex(submitted.fields.getTextInputValue('role_color'));
      if (parsed === null) {
        await submitted.reply({
          content: '❌ Invalid hex color — please try again with a format like `#ff00ff`.',
          ephemeral: true,
        });
        return;
      }

      s.color = parsed;
      setupSessions.set(userId, s);

      await submitted.deferUpdate();
      await submitted.editReply({
        embeds:     [buildSetupEmbed(member, s, 'icon')],
        components: [makeIconRow(hasRoleIcons)],
      });
      return;
    }

    // ── Step 3a: Icon — emoji ────────────────────────────────
    if (btn.customId === 'booster_setup_icon_emoji') {
      const modal = new ModalBuilder()
        .setCustomId('booster_modal_icon_emoji')
        .setTitle('Set Role Icon — Emoji')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('role_emoji')
              .setLabel('Enter a custom server emoji')
              .setPlaceholder(':emoji_name: or paste the emoji directly')
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );

      await btn.showModal(modal);

      const submitted = await btn.awaitModalSubmit({
        filter: (m) => m.customId === 'booster_modal_icon_emoji' && m.user.id === userId,
        time: 60_000,
      }).catch(() => null);

      if (!submitted) return;

      const emojiInput = submitted.fields.getTextInputValue('role_emoji').trim();
      const fullMatch  = emojiInput.match(/^<(a?):(\w+):(\d+)>$/);
      let resolvedEmoji: string | null = null;

      if (fullMatch) {
        resolvedEmoji = emojiInput;
      } else {
        const nameMatch = emojiInput.match(/^:?(\w+):?$/);
        const found = nameMatch
          ? guild.emojis.cache.find((e) => e.name === nameMatch[1])
          : null;
        if (found) resolvedEmoji = found.toString();
      }

      if (!resolvedEmoji) {
        await submitted.reply({
          content: '❌ Could not find that emoji in this server. Please try again.',
          ephemeral: true,
        });
        return;
      }

      s.icon = resolvedEmoji;
      setupSessions.set(userId, s);
      await finishSetup(submitted, member, client, s, collector);
      return;
    }

    // ── Step 3b: Icon — URL ──────────────────────────────────
    if (btn.customId === 'booster_setup_icon_url') {
      const modal = new ModalBuilder()
        .setCustomId('booster_modal_icon_url')
        .setTitle('Set Role Icon — Image URL')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('role_url')
              .setLabel('Direct image URL (png/jpg/gif/webp)')
              .setPlaceholder('https://...')
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );

      await btn.showModal(modal);

      const submitted = await btn.awaitModalSubmit({
        filter: (m) => m.customId === 'booster_modal_icon_url' && m.user.id === userId,
        time: 60_000,
      }).catch(() => null);

      if (!submitted) return;

      const url = submitted.fields.getTextInputValue('role_url').trim();
      if (!/^https?:\/\//i.test(url)) {
        await submitted.reply({
          content: '❌ Please provide a URL starting with `https://`.',
          ephemeral: true,
        });
        return;
      }

      try {
        const res = await fetch(url, { method: 'HEAD' });
        const ct  = res.headers.get('content-type') ?? '';
        if (!ct.startsWith('image/')) {
          await submitted.reply({
            content: '❌ That URL does not appear to serve an image.',
            ephemeral: true,
          });
          return;
        }
      } catch {
        await submitted.reply({
          content: '❌ Could not reach that URL. Make sure it is publicly accessible.',
          ephemeral: true,
        });
        return;
      }

      s.icon = url;
      setupSessions.set(userId, s);
      await finishSetup(submitted, member, client, s, collector);
      return;
    }

    // ── Step 3c: Icon — upload ───────────────────────────────
    // Modals can't accept file uploads, so we ask the user to send
    // their image as a follow-up message and collect it.
    if (btn.customId === 'booster_setup_icon_upload') {
      await btn.update({
        embeds: [
          buildSetupEmbed(member, s, 'icon')
            .setDescription(
              '📁 **Send your image as a message in this channel now.**\n' +
              'It must be a `.png`, `.jpg`, `.gif`, or `.webp` file under **256kb**.\n\n' +
              '*Waiting up to 60 seconds…*',
            ),
        ],
        components: [],
      });

      const msgCollector = (interaction.channel as TextChannel).createMessageCollector({
        filter: (m: Message) => m.author.id === userId && m.attachments.size > 0,
        max:  1,
        time: 60_000,
      });

      msgCollector.on('collect', async (msg: Message) => {
        const attachment = msg.attachments.first()!;
        const ct = attachment.contentType ?? '';

        if (!ct.startsWith('image/')) {
          await msg.reply({ content: '❌ That file is not an image. Run `/booster setup` to try again.' });
          setupSessions.delete(userId);
          collector.stop('cancelled');
          return;
        }

        if (attachment.size > 256 * 1024) {
          await msg.reply({
            content: `❌ Image is too large (${Math.round(attachment.size / 1024)}kb). Must be under 256kb. Run \`/booster setup\` to try again.`,
          });
          setupSessions.delete(userId);
          collector.stop('cancelled');
          return;
        }

        // Delete the upload message to keep the channel tidy
        await msg.delete().catch(() => null);

        s.icon = attachment.url;
        setupSessions.set(userId, s);

        const role = await applyRoleChanges(member, client, s);
        await upsertBoosterCard(member, client, role);
        setupSessions.delete(userId);
        collector.stop('done');

        await interaction.editReply({
          embeds:     [buildSetupEmbed(member, s, 'done')],
          components: [],
        });
      });

      msgCollector.on('end', async (collected: ReadonlyCollection<string, Message>) => {
        if (collected.size === 0) {
          await interaction.editReply({
            embeds: [
              buildSetupEmbed(member, s, 'icon')
                .setDescription('⏱ Timed out waiting for an image. Run `/booster setup` again to retry.'),
            ],
            components: [],
          }).catch(() => null);
          setupSessions.delete(userId);
          collector.stop('cancelled');
        }
      });

      return;
    }

    // ── Step 3d: Icon — skip ─────────────────────────────────
    if (btn.customId === 'booster_setup_icon_skip') {
      s.icon = null;
      setupSessions.set(userId, s);
      await finishSetup(btn, member, client, s, collector);
      return;
    }
  });

  // Collector timeout
  collector.on('end', async (_collected, reason) => {
    if (reason === 'time') {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle('⏱ Setup timed out')
            .setDescription('Run `/booster setup` again to start over.'),
        ],
        components: [],
      }).catch(() => null);
      setupSessions.delete(userId);
    }
  });
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

  // /booster setup — handles its own reply internally, no defer
  if (sub === 'setup' && !group) {
    await handleBoosterSetup(interaction, client);
    return;
  }

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
      await upsertBoosterCard(member, client, role).catch(() => null);
      await interaction.editReply({
        content: `✅ Color set to **#${color.toString(16).padStart(6, '0').toUpperCase()}** and your showcase card has been updated.`,
      });
      return;
    }

    // /booster reset
    if (sub === 'reset') {
      await role.setColor(0x000000, 'Booster reset color');
      await upsertBoosterCard(member, client, role).catch(() => null);
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

      // Custom server emoji must be passed as its CDN image URL
      const emojiIdMatch = resolvedEmoji.match(/^<a?:\w+:(\d+)>$/);
      if (emojiIdMatch) {
        await role.edit({ icon: `https://cdn.discordapp.com/emojis/${emojiIdMatch[1]}.png` });
      } else {
        // Standard unicode emoji
        await role.edit({ unicodeEmoji: resolvedEmoji });
      }
      await upsertBoosterCard(member, client, role).catch(() => null);
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
      try {
        const res = await fetch(url, { method: 'HEAD' });
        const ct  = res.headers.get('content-type') ?? '';
        if (!ct.startsWith('image/')) {
          await interaction.editReply({ content: '❌ That URL does not appear to serve an image.' });
          return;
        }
      } catch {
        await interaction.editReply({ content: '❌ Could not reach that URL.' });
        return;
      }
      await role.edit({ icon: url });
      await upsertBoosterCard(member, client, role).catch(() => null);
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
      const ct = attachment.contentType ?? '';
      if (!ct.startsWith('image/')) {
        await interaction.editReply({ content: '❌ That file is not an image.' });
        return;
      }
      if (attachment.size > 256 * 1024) {
        await interaction.editReply({ content: `❌ Image is too large (${Math.round(attachment.size / 1024)}kb). Must be under 256kb.` });
        return;
      }
      await role.edit({ icon: attachment.url, reason: 'Booster uploaded role icon' });
      await upsertBoosterCard(member, client, role).catch(() => null);
      await interaction.editReply({ content: '✅ Role icon set from your uploaded image.' });
      return;
    }

    // /booster icon clear
    if (group === 'icon' && sub === 'clear') {
      await role.edit({ icon: null, unicodeEmoji: null });
      await upsertBoosterCard(member, client, role).catch(() => null);
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

    const role = interaction.guild.roles.cache.get(stored.roleId)
      ?? await interaction.guild.roles.fetch(stored.roleId).catch(() => null);
    if (role) await role.delete('Admin cleared booster role').catch(() => null);
    deleteBoosterRole(interaction.guild.id, user.id);

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (member) await removeBoosterCard(member, interaction.guild);

    await interaction.editReply({ content: `✅ Removed booster role and card for **${user.tag}**.` });
    return;
  }

  // /boosteradmin sync
  if (sub === 'sync') {
    await interaction.deferReply({ ephemeral: true });

    const shouldPrune = interaction.options.getBoolean('prune') ?? true;
    const guild       = interaction.guild;

    await guild.members.fetch();
    const currentBoosters = guild.members.cache.filter((m) => !!m.premiumSince);

    let cardsPosted  = 0;
    let rolesCreated = 0;
    let cardsFailed  = 0;
    let pruned       = 0;
    const errors: string[] = [];

    for (const [, boostMember] of currentBoosters) {
      try {
        const hadRecord = !!getBoosterRole(guild.id, boostMember.id);
        const role      = await getOrCreateBoosterRole(boostMember, client);
        if (!hadRecord) rolesCreated++;

        const existingCardId = getBoosterCard(guild.id, boostMember.id);

        if (existingCardId) {
          const channelId = getBoosterShowcaseChannel(guild.id);
          let messageExists = false;
          if (channelId) {
            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (channel?.isTextBased()) {
              const msg = await (channel as TextChannel).messages
                .fetch(existingCardId)
                .catch(() => null);
              messageExists = !!msg;
            }
          }
          if (!messageExists) {
            deleteBoosterCard(guild.id, boostMember.id);
            await upsertBoosterCard(boostMember, client, role);
            cardsPosted++;
          }
        } else {
          await upsertBoosterCard(boostMember, client, role);
          cardsPosted++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`<@${boostMember.id}>: ${msg}`);
        cardsFailed++;
      }
    }

    if (shouldPrune) {
      const allRecords = getAllBoosterRoles(guild.id);
      for (const row of allRecords) {
        if (currentBoosters.has(row.userId as Snowflake)) continue;
        try {
          const role = guild.roles.cache.get(row.roleId as Snowflake)
            ?? await guild.roles.fetch(row.roleId).catch(() => null);
          if (role) await role.delete('Booster sync prune').catch(() => null);
          deleteBoosterRole(guild.id, row.userId);

          const staleCardId = getBoosterCard(guild.id, row.userId);
          if (staleCardId) {
            const channelId = getBoosterShowcaseChannel(guild.id);
            if (channelId) {
              const channel = await guild.channels.fetch(channelId).catch(() => null);
              if (channel?.isTextBased()) {
                const msg = await (channel as TextChannel).messages
                  .fetch(staleCardId)
                  .catch(() => null);
                if (msg) await msg.delete().catch(() => null);
              }
            }
            deleteBoosterCard(guild.id, row.userId);
          }
          pruned++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Prune <@${row.userId}>: ${msg}`);
        }
      }
    }

    const lines: string[] = [
      `**🔄 Booster sync complete**`,
      `👥 Active boosters found: **${currentBoosters.size}**`,
      `📬 Cards posted/restored: **${cardsPosted}**`,
      `🎨 Roles created: **${rolesCreated}**`,
    ];
    if (shouldPrune) lines.push(`🗑 Stale records pruned: **${pruned}**`);
    if (cardsFailed) lines.push(`⚠️ Failures: **${cardsFailed}**`);
    if (errors.length) {
      lines.push('', '**Errors:**');
      lines.push(...errors.slice(0, 10).map((e) => `• ${e}`));
      if (errors.length > 10) lines.push(`…and ${errors.length - 10} more`);
    }

    await interaction.editReply({ content: lines.join('\n') });
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

  if (!wasBoosting && nowBoosting) {
    await new Promise((r) => setTimeout(r, 2_000));
    const freshMember = await newMember.guild.members.fetch(newMember.id).catch(() => newMember);
    await upsertBoosterCard(freshMember, client, null);
    console.log(`💎 ${newMember.user.tag} started boosting — card posted`);
  }

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
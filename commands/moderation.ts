import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import {
  addWarning,
  getWarnings,
  getTotalWarningPoints,
  clearWarnings,
  removeWarningById,
} from '../utils/database';

// ── TODO: adjust threshold if you want something other than 3 ──
const BAN_THRESHOLD_POINTS = 3;

// ─── Command definitions ───────────────────────────────────────

export const warnCommand = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Give a user warning points')
  .addUserOption(opt => opt.setName('user').setDescription('The user to warn').setRequired(true))
  .addIntegerOption(opt =>
    opt.setName('points').setDescription('How many warning points').setRequired(true).setMinValue(1).setMaxValue(3),
  )
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for the warning').setRequired(false));

export const warningsCommand = new SlashCommandBuilder()
  .setName('warnings')
  .setDescription('View a user\'s warning history')
  .addUserOption(opt => opt.setName('user').setDescription('The user to check').setRequired(true));

export const clearWarningsCommand = new SlashCommandBuilder()
  .setName('clearwarnings')
  .setDescription('Clear all warnings for a user')
  .addUserOption(opt => opt.setName('user').setDescription('The user to clear').setRequired(true));

export const banCommand = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a user from the server')
  .addUserOption(opt => opt.setName('user').setDescription('The user to ban').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for the ban').setRequired(false));

// ─── Handlers ────────────────────────────────────────────────

export async function handleWarnInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  if (!interaction.guild) {
    await interaction.editReply('This command only works in a server.');
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const points = interaction.options.getInteger('points', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided';

  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    await interaction.editReply('Could not find that member in this server.');
    return;
  }

  addWarning(interaction.guild.id, targetUser.id, points, reason, interaction.user.id);
  const totalPoints = getTotalWarningPoints(interaction.guild.id, targetUser.id);

  if (totalPoints >= BAN_THRESHOLD_POINTS) {
    try {
      await member.send(
        `You have been banned from **${interaction.guild.name}** for accumulating ${totalPoints} warning point(s).`,
      ).catch(() => null); // DMs may be closed, don't block the ban on this

      await member.ban({ reason: `Auto-ban: reached ${totalPoints} warning points` });

      await interaction.editReply(
        `⚠️ ${targetUser.tag} was warned ${points} point(s) for: ${reason}\n` +
        `🔨 That brought them to ${totalPoints} total points — **auto-banned**.`,
      );
    } catch (e) {
      console.error('[moderation] Error auto-banning member:', e);
      await interaction.editReply(
        `⚠️ ${targetUser.tag} was warned but hit the ban threshold and I failed to ban them — check my permissions/role hierarchy.`,
      );
    }
    return;
  }

  await interaction.editReply(
    `⚠️ ${targetUser.tag} was warned ${points} point(s) for: ${reason}\n` +
    `Total: ${totalPoints}/${BAN_THRESHOLD_POINTS} points.`,
  );
}

export async function handleWarningsInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guild) {
    await interaction.editReply('This command only works in a server.');
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const warnings = getWarnings(interaction.guild.id, targetUser.id);
  const totalPoints = getTotalWarningPoints(interaction.guild.id, targetUser.id);

  if (warnings.length === 0) {
    await interaction.editReply(`${targetUser.tag} has no warnings.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Warnings for ${targetUser.tag}`)
    .setDescription(`Total: ${totalPoints}/${BAN_THRESHOLD_POINTS} points`)
    .setColor(0xffaa00)
    .addFields(
      warnings.slice(0, 10).map(w => ({
        name: `#${w.id} — ${w.points} point(s) — <t:${Math.floor(w.createdTs / 1000)}:R>`,
        value: `Reason: ${w.reason}\nBy: <@${w.modId}>`,
      })),
    );

  await interaction.editReply({ embeds: [embed] });
}

export async function handleClearWarningsInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guild) {
    await interaction.editReply('This command only works in a server.');
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  clearWarnings(interaction.guild.id, targetUser.id);
  await interaction.editReply(`Cleared all warnings for ${targetUser.tag}.`);
}

export async function handleBanInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  if (!interaction.guild) {
    await interaction.editReply('This command only works in a server.');
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided';

  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  try {
    if (member) {
      await member.send(`You have been banned from **${interaction.guild.name}**. Reason: ${reason}`).catch(() => null);
    }
    await interaction.guild.members.ban(targetUser.id, { reason: `${reason} — by ${interaction.user.tag}` });
    await interaction.editReply(`🔨 Banned ${targetUser.tag}. Reason: ${reason}`);
  } catch (e) {
    console.error('[moderation] Error banning member:', e);
    await interaction.editReply('Failed to ban that user — check my permissions/role hierarchy.');
  }
}
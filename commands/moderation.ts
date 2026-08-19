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

// ─── Warning reason presets ─────────────────────────────────────
// value = what gets stored in the "choice" internally
// label = what shows in the dropdown
// points = weight of this warning (kept for record-keeping / severity, no longer tied to a ban threshold)

interface WarningReason {
  value: string;
  label: string;
  points: number;
}

const WARNING_REASONS: WarningReason[] = [
  { value: 'gore_shock',            label: 'Gore/Shock media',                          points: 1 },
  { value: 'hardcore_porn_harm',    label: 'Hardcore porn (bodily harm/death)',         points: 1 },
  { value: 'loli_porn',             label: 'Loli porn (instant ban in general chat)',   points: 1 },
  { value: 'revenge_porn',          label: 'Revenge porn',                              points: 1 },
  { value: 'nsfw_general',          label: 'NSFW/NSFL in general chat',                 points: 1 },
  { value: 'poaching',              label: 'Poaching (publicly)',                       points: 1 },
  { value: 'harassment_suicide',    label: 'Harassment (suicide encouragement)',        points: 2 },
  { value: 'racism_transphobia',    label: 'Overboard racism/transphobia',              points: 2 },
  { value: 'sexualizing_minors',    label: 'Sexualizing minors',                        points: 2 },
  { value: 'threatening_server',    label: 'Threatening the server (incl. misinfo)',    points: 2 },
  { value: 'threatening_selfharm',  label: 'Threatening self harm',                     points: 2 },
  { value: 'accusation_pedo',       label: 'Accusation of pedo without proof',          points: 2 },
  { value: 'reportfagging',         label: 'Reportingfagging',                          points: 1 },
  { value: 'doxxing',               label: 'Doxxing (ban)',                             points: 3 },
  { value: 'blackmail',             label: 'Blackmail (ban)',                           points: 3 },
  { value: 'extremism',             label: 'Extremism',                                 points: 1 },
  { value: 'cutting_vc',            label: 'Cutting/Injecting in VC, witnessed (ban)',  points: 3 },
];

function getReasonByValue(value: string): WarningReason | undefined {
  return WARNING_REASONS.find(r => r.value === value);
}

// ─── Command definitions ───────────────────────────────────────

export const warnCommand = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Give a user warning points')
  .addUserOption(opt => opt.setName('user').setDescription('The user to warn').setRequired(true))
  .addStringOption(opt =>
    opt
      .setName('reason')
      .setDescription('Reason for the warning')
      .setRequired(true)
      .addChoices(...WARNING_REASONS.map(r => ({ name: r.label, value: r.value }))),
  )
  .addStringOption(opt =>
    opt.setName('note').setDescription('Optional extra context/details').setRequired(false),
  );

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
  const reasonValue = interaction.options.getString('reason', true);
  const note = interaction.options.getString('note');

  const reasonPreset = getReasonByValue(reasonValue);
  if (!reasonPreset) {
    await interaction.editReply('Unrecognized reason — please pick one from the dropdown.');
    return;
  }

  const points = reasonPreset.points;
  const fullReason = note ? `${reasonPreset.label} — ${note}` : reasonPreset.label;

  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    await interaction.editReply('Could not find that member in this server.');
    return;
  }

  addWarning(interaction.guild.id, targetUser.id, points, fullReason, interaction.user.id);

  const allWarnings = getWarnings(interaction.guild.id, targetUser.id);
  const warnCount = allWarnings.length;
  const totalPoints = getTotalWarningPoints(interaction.guild.id, targetUser.id);

  await member.send(
    `You were warned in **${interaction.guild.name}**: ${fullReason}`,
  ).catch(() => null); // best-effort, ignore if DMs are closed

  await interaction.editReply(
    `⚠️ ${targetUser.tag} was warned for: ${fullReason}\n` +
    `This is warning **#${warnCount}** for this user (${totalPoints} total point(s)).`,
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
    .setDescription(`Total: **${warnings.length}** warning(s), ${totalPoints} point(s)`)
    .setColor(0xffaa00)
    .addFields(
      warnings.slice(0, 10).map((w, i) => ({
        name: `#${warnings.length - i} — ${w.points} point(s) — <t:${Math.floor(w.createdTs / 1000)}:R>`,
        value: `Reason: ${w.reason}\nBy: <@${w.modId}>`,
      })),
    );

  if (warnings.length > 10) {
    embed.setFooter({ text: `Showing 10 most recent of ${warnings.length} total warnings` });
  }

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
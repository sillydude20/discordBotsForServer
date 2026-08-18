import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { saveLimboBackup, getLimboBackup, deleteLimboBackup } from '../utils/database';

// ── TODO: replace with the real role ID once the limbo role exists ──
const LIMBO_ROLE_ID = 'DUMMY_LIMBO_ROLE_ID';

export const limboCommand = new SlashCommandBuilder()
  .setName('limbo')
  .setDescription('Strip a user of their roles and send them to limbo')
  .addUserOption(opt =>
    opt.setName('user').setDescription('The user to limbo').setRequired(true),
  );

export const unlimboCommand = new SlashCommandBuilder()
  .setName('unlimbo')
  .setDescription('Restore a limboed user\'s roles')
  .addUserOption(opt =>
    opt.setName('user').setDescription('The user to unlimbo').setRequired(true),
  );

export async function handleLimboInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guild) {
    await interaction.editReply('This command only works in a server.');
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  if (!member) {
    await interaction.editReply('Could not find that member in this server.');
    return;
  }

  if (member.roles.cache.has(LIMBO_ROLE_ID)) {
    await interaction.editReply(`${member.user.tag} is already in limbo.`);
    return;
  }

  const currentRoleIds = member.roles.cache
    .filter(role => role.id !== interaction.guild!.id && !role.managed)
    .map(role => role.id);

  try {
    saveLimboBackup(interaction.guild.id, member.id, currentRoleIds);

    if (currentRoleIds.length > 0) {
      await member.roles.remove(currentRoleIds, `Limboed by ${interaction.user.tag}`);
    }
    await member.roles.add(LIMBO_ROLE_ID, `Limboed by ${interaction.user.tag}`);

    await interaction.editReply(`${member.user.tag} has been sent to limbo. (${currentRoleIds.length} role(s) backed up)`);
  } catch (e) {
    console.error('[limbo] Error limboing member:', e);
    await interaction.editReply('Something went wrong trying to limbo that user.');
  }
}

export async function handleUnlimboInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guild) {
    await interaction.editReply('This command only works in a server.');
    return;
  }

  const targetUser = interaction.options.getUser('user', true);
  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  if (!member) {
    await interaction.editReply('Could not find that member in this server.');
    return;
  }

  if (!member.roles.cache.has(LIMBO_ROLE_ID)) {
    await interaction.editReply(`${member.user.tag} isn't in limbo.`);
    return;
  }

  try {
    const backedUpRoleIds = getLimboBackup(interaction.guild.id, member.id) ?? [];
    const validRoleIds = backedUpRoleIds.filter(id => interaction.guild!.roles.cache.has(id));

    await member.roles.remove(LIMBO_ROLE_ID, `Unlimboed by ${interaction.user.tag}`);

    if (validRoleIds.length > 0) {
      await member.roles.add(validRoleIds, `Unlimboed by ${interaction.user.tag}`);
    }

    deleteLimboBackup(interaction.guild.id, member.id);
    await interaction.editReply(`${member.user.tag} has been released from limbo. (${validRoleIds.length} role(s) restored)`);
  } catch (e) {
    console.error('[limbo] Error unlimboing member:', e);
    await interaction.editReply('Something went wrong trying to unlimbo that user.');
  }
}
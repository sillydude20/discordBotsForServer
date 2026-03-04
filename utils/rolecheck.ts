// src/utils/rolecheck.ts
// ─────────────────────────────────────────────────────────────
// Central role-check utility.
//
// Setup:
//   /setuprole @role  — set the admin role for this server
//   /setuprole clear  — remove the restriction (server owner only)
//   /setuprole status — show the current admin role
//
// Any command gated with hasAdminRole() will silently reject
// users who don't have the configured role (or Manage Guild).
// Server owners always bypass the check.
// ─────────────────────────────────────────────────────────────

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  GuildMember,
} from 'discord.js';
import {
  getAdminRole,
  saveAdminRole,
  deleteAdminRole,
} from './database';

// ── In-memory cache ───────────────────────────────────────────
// Map<guildId, roleId>
const adminRoleCache = new Map<string, string>();

export function loadAdminRoles(): void {
  const rows = getAdminRole();
  adminRoleCache.clear();
  for (const row of rows) {
    adminRoleCache.set(row.guildId, row.roleId);
  }
  console.log(`📦 Loaded ${adminRoleCache.size} admin role config(s) from database`);
}

// ── Core check ────────────────────────────────────────────────
// Returns true if the member is allowed to use admin commands.
// Allowed if ANY of:
//   1. They are the server owner
//   2. They have Manage Guild permission
//   3. They have the configured admin role

export function hasAdminRole(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.guild || !interaction.member) return false;

  const member = interaction.member as GuildMember;

  // Server owner always passes
  if (interaction.guild.ownerId === member.id) return true;

  // ManageGuild permission always passes
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;

  // Check configured admin role
  const roleId = adminRoleCache.get(interaction.guild.id);
  if (roleId && member.roles.cache.has(roleId)) return true;

  return false;
}

// Sends a standardised denial reply and returns false — use like:
//   if (!await checkAdminRole(interaction)) return;
export async function checkAdminRole(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (hasAdminRole(interaction)) return true;

  const roleId = adminRoleCache.get(interaction.guild!.id);
  const roleMention = roleId ? `<@&${roleId}>` : 'a designated admin role';

  await interaction.reply({
    content: `❌ You need the ${roleMention} role to use this command.`,
    ephemeral: true,
  });
  return false;
}

// ── /setuprole command ────────────────────────────────────────

export const setupRoleCommand = new SlashCommandBuilder()
  .setName('setuprole')
  .setDescription('Configure which role can use bot admin commands')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set the admin role')
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('Role to grant access').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('clear').setDescription('Remove the role restriction'),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show the current admin role'),
  );

export async function handleSetupRoleInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== 'setuprole') return;
  if (!interaction.guild) return;

  // This command itself requires ManageGuild (set on the builder above)
  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const role = interaction.options.getRole('role', true);

    adminRoleCache.set(interaction.guild.id, role.id);
    saveAdminRole(interaction.guild.id, role.id);

    await interaction.reply({
      content: `✅ Admin role set to <@&${role.id}>. Only members with this role (or Manage Guild) can use bot admin commands.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'clear') {
    adminRoleCache.delete(interaction.guild.id);
    deleteAdminRole(interaction.guild.id);

    await interaction.reply({
      content: '✅ Admin role restriction removed. Commands now fall back to the Manage Guild permission check.',
      ephemeral: true,
    });
    return;
  }

  if (sub === 'status') {
    const roleId = adminRoleCache.get(interaction.guild.id);
    if (!roleId) {
      await interaction.reply({
        content: 'ℹ️ No admin role configured. Commands are restricted to members with Manage Guild permission.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: `📋 Current admin role: <@&${roleId}>`,
      ephemeral: true,
    });
  }
}


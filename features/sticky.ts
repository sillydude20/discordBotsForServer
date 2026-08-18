import { GuildMember, PartialGuildMember } from 'discord.js';
import { saveMemberRoles, getMemberRoles, deleteMemberRoles } from '../utils/database';

// Called on guildMemberRemove
export async function handleStickyRolesLeave(
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  try {
    const roleIds = member.roles.cache
      .filter(role => role.id !== member.guild.id && !role.managed) // skip @everyone + bot/booster/integration roles
      .map(role => role.id);

    if (roleIds.length === 0) {
      deleteMemberRoles(member.guild.id, member.id);
      return;
    }

    saveMemberRoles(member.guild.id, member.id, roleIds);
    console.log(`[stickyRoles] Saved ${roleIds.length} role(s) for ${member.user?.tag ?? member.id} in ${member.guild.name}`);
  } catch (e) {
    console.error('[stickyRoles] Error saving roles on leave:', e);
  }
}

// Called on guildMemberAdd
export async function handleStickyRolesJoin(member: GuildMember): Promise<void> {
  try {
    const savedRoleIds = getMemberRoles(member.guild.id, member.id);
    if (savedRoleIds.length === 0) return;

    // Filter out roles that no longer exist or are managed (safety check in case cache changed)
    const validRoleIds = savedRoleIds.filter(id => {
      const role = member.guild.roles.cache.get(id);
      return role && !role.managed;
    });

    if (validRoleIds.length === 0) {
      deleteMemberRoles(member.guild.id, member.id);
      return;
    }

    await member.roles.add(validRoleIds, 'Sticky roles: restored on rejoin');
    console.log(`[stickyRoles] Restored ${validRoleIds.length} role(s) for ${member.user.tag} in ${member.guild.name}`);

    deleteMemberRoles(member.guild.id, member.id);
  } catch (e) {
    console.error('[stickyRoles] Error restoring roles on join:', e);
  }
}
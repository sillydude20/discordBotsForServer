import { Client, Message, GuildMember } from 'discord.js';
import {
  updateLastMessageTimestamp,
  getLastMessageTimestamp,
  getInactiveUserIds,
  saveDeadRoleBackup,
  getDeadRoleBackup,
  deleteDeadRoleBackup,
} from '../utils/database';

// ── TODO: replace with real values once the server/channel/role exist ──
const DEAD_ROLE_GUILD_ID = 'DUMMY_GUILD_ID';
const DEAD_CHANNEL_ID = 'DUMMY_DEAD_CHANNEL_ID';
const DEAD_ROLE_ID = 'DUMMY_DEAD_ROLE_ID';
const INACTIVITY_DAYS = 15; // how long with no messages before someone is "dead"
const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000; // check every 6 hours

// Call this on every message in the guild to keep last-active timestamps fresh
export function trackLastMessage(guildId: string, userId: string, timestampMs: number): void {
  updateLastMessageTimestamp(guildId, userId, timestampMs);
}

// Periodic sweep: find inactive members, strip their roles, assign the dead role
async function checkInactiveMembers(client: Client): Promise<void> {
  const guild = client.guilds.cache.get(DEAD_ROLE_GUILD_ID);
  if (!guild) return;

  const cutoffTs = Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  const inactiveFromMessages = getInactiveUserIds(DEAD_ROLE_GUILD_ID, cutoffTs);
  const inactiveUserIds = new Set(inactiveFromMessages);

  // Catch members who joined long enough ago but never posted at all
  // (never appeared in user_last_message, so getInactiveUserIds can't see them)
  try {
    const allMembers = await guild.members.fetch();
    for (const member of allMembers.values()) {
      if (member.user.bot) continue;
      if (inactiveUserIds.has(member.id)) continue; // already caught above

      const lastMsgTs = getLastMessageTimestamp(guild.id, member.id);
      if (lastMsgTs !== null) continue; // they've posted before, handled by the query above

      const joinedTs = member.joinedTimestamp;
      if (joinedTs !== null && joinedTs < cutoffTs) {
        inactiveUserIds.add(member.id);
      }
    }
  } catch (e) {
    console.error('[deadRoles] Error fetching full member list for lurker check:', e);
  }

  for (const userId of inactiveUserIds) {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (member.roles.cache.has(DEAD_ROLE_ID)) continue; // already dead, skip

      const currentRoleIds = member.roles.cache
        .filter(role => role.id !== guild.id && !role.managed && role.id !== DEAD_ROLE_ID)
        .map(role => role.id);

      saveDeadRoleBackup(guild.id, userId, currentRoleIds);

      if (currentRoleIds.length > 0) {
        await member.roles.remove(currentRoleIds, 'Marked inactive: dead role sweep');
      }
      await member.roles.add(DEAD_ROLE_ID, 'Marked inactive: dead role sweep');

      console.log(`[deadRoles] Marked ${member.user.tag} as inactive (${currentRoleIds.length} role(s) backed up)`);
    } catch (e) {
      console.error(`[deadRoles] Error processing inactive user ${userId}:`, e);
    }
  }
}

export function startDeadRoleSweep(client: Client): void {
  setInterval(() => checkInactiveMembers(client), SWEEP_INTERVAL_MS);
  console.log('[deadRoles] Sweep loop started');
}

// Called on every message — reactivates a user if they post in the dead channel
export async function handleDeadChannelReactivation(message: Message): Promise<void> {
  if (message.guild?.id !== DEAD_ROLE_GUILD_ID) return;
  if (message.channelId !== DEAD_CHANNEL_ID) return;
  if (message.author.bot) return;

  const member = message.member;
  if (!member || !member.roles.cache.has(DEAD_ROLE_ID)) return;

  try {
    const backedUpRoleIds = getDeadRoleBackup(message.guild.id, member.id);

    await member.roles.remove(DEAD_ROLE_ID, 'Reactivated: posted in dead channel');

    const validRoleIds = backedUpRoleIds.filter(id => message.guild!.roles.cache.has(id));
    if (validRoleIds.length > 0) {
      await member.roles.add(validRoleIds, 'Reactivated: posted in dead channel');
    }

    deleteDeadRoleBackup(message.guild.id, member.id);
    console.log(`[deadRoles] Reactivated ${member.user.tag}, restored ${validRoleIds.length} role(s)`);
  } catch (e) {
    console.error('[deadRoles] Error reactivating member:', e);
  }
}
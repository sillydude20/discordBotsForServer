// src/features/activity.ts
// ─────────────────────────────────────────────────────────────
// Tracks per-user message counts (total, no dates) and voice seconds.
// Voice seconds are flushed to DB every 5 minutes so bot restarts
// don't lose accumulated time.
//
// Commands:
//   /activity setchannel #channel   — track messages in a channel
//   /activity removechannel #channel
//   /activity listchannels
//   /activity stats [@user]
//   /activity leaderboard
// ─────────────────────────────────────────────────────────────

import {
  Client,
  VoiceState,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  Colors,
  GuildMember,
} from 'discord.js';
import {
  incrementMessageCount,
  addVoiceSeconds,
  getUserTotals,
  getTopUsers,
  getTrackedChannels,
  addTrackedChannel,
  removeTrackedChannel,
} from '../utils/database';

// ── Tracked channels (in-memory set for fast lookup) ─────────
const trackedChannels = new Set<string>(); // channelId

export function loadActivityConfig(guildId: string): void {
  const channels = getTrackedChannels(guildId);
  for (const id of channels) trackedChannels.add(id);
  console.log(`📦 Loaded ${channels.length} activity-tracked channel(s) for guild ${guildId}`);
}

export function isTrackedChannel(channelId: string): boolean {
  return trackedChannels.has(channelId);
}

// ── Voice session tracking ────────────────────────────────────
// Map<`${guildId}:${userId}`, { joinedAt: number, accumulated: number }>
// accumulated = seconds already flushed to DB this session (before last flush)

interface VoiceSession {
  joinedAt: number;     // ms timestamp of last join / last flush
  buffered: number;     // seconds written to DB so far this session
}

const voiceSessions = new Map<string, VoiceSession>();

export function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const userId  = newState.id;
  const guildId = newState.guild.id;
  const key     = `${guildId}:${userId}`;

  const joined   = !oldState.channelId && newState.channelId;
  const left     = oldState.channelId  && !newState.channelId;
  const switched = oldState.channelId  && newState.channelId && oldState.channelId !== newState.channelId;

  if (joined) {
    voiceSessions.set(key, { joinedAt: Date.now(), buffered: 0 });
    console.log(`🎙 [voice] ${userId} joined in guild ${guildId}`);
    return;
  }

  if (left || switched) {
    const session = voiceSessions.get(key);
    if (session) {
      const seconds = Math.floor((Date.now() - session.joinedAt) / 1000);
      if (seconds > 0) {
        addVoiceSeconds(guildId, userId, seconds);
        console.log(`🎙 [voice] ${userId} left — flushing ${seconds}s`);
      }
      voiceSessions.delete(key);
    }
    if (switched) {
      voiceSessions.set(key, { joinedAt: Date.now(), buffered: 0 });
    }
  }
}

// ── Periodic voice flush (every 5 minutes) ───────────────────
// Writes accumulated seconds for all active sessions to DB,
// then resets joinedAt so we don't double-count on the next flush.

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export function startVoiceFlushLoop(): void {
  setInterval(() => {
    const now = Date.now();
    let flushed = 0;

    for (const [key, session] of voiceSessions.entries()) {
      const seconds = Math.floor((now - session.joinedAt) / 1000);
      if (seconds <= 0) continue;

      const [guildId, userId] = key.split(':');
      addVoiceSeconds(guildId, userId, seconds);

      // Reset joinedAt to now so next flush only counts new time
      session.joinedAt = now;
      flushed++;
    }

    if (flushed > 0) {
      console.log(`🎙 [voice flush] Wrote active session time for ${flushed} user(s)`);
    }
  }, FLUSH_INTERVAL_MS);

  console.log(`🔁 Voice flush loop running every ${FLUSH_INTERVAL_MS / 1000}s`);
}

// ── Message counting ──────────────────────────────────────────

export function handleActivityMessage(guildId: string, userId: string, channelId: string): void {
  if (!trackedChannels.has(channelId)) return;
  incrementMessageCount(guildId, userId);
}

// ── Slash command ─────────────────────────────────────────────

export const activityCommand = new SlashCommandBuilder()
  .setName('activity')
  .setDescription('Activity tracking')
  .addSubcommand(sub =>
    sub.setName('setchannel')
      .setDescription('Track messages in a channel')
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Channel to track').setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('removechannel')
      .setDescription('Stop tracking messages in a channel')
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Channel to remove').setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('listchannels')
      .setDescription('List all tracked channels'),
  )
  .addSubcommand(sub =>
    sub.setName('stats')
      .setDescription('Show stats for a user')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to check (default: yourself)').setRequired(false),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('flushvoice')
    .setDescription('Force flush all active voice sessions to the database'),
)
  .addSubcommand(sub =>
    sub.setName('leaderboard')
      .setDescription('Top 10 most active members'),
  );

// ── Interaction handler ───────────────────────────────────────

export async function handleActivityInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== 'activity') return;
  if (!interaction.guild) return;

  const sub     = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  // /activity setchannel
  if (sub === 'setchannel') {
    const channel = interaction.options.getChannel('channel', true);
    addTrackedChannel(guildId, channel.id);
    trackedChannels.add(channel.id);
    await interaction.reply({
      content: `✅ Now tracking messages in <#${channel.id}>.`,
      ephemeral: true,
    });
    return;
  }

  // /activity removechannel
  if (sub === 'removechannel') {
    const channel = interaction.options.getChannel('channel', true);
    removeTrackedChannel(guildId, channel.id);
    trackedChannels.delete(channel.id);
    await interaction.reply({
      content: `✅ No longer tracking messages in <#${channel.id}>.`,
      ephemeral: true,
    });
    return;
  }

  // /activity listchannels
  if (sub === 'listchannels') {
    const channels = getTrackedChannels(guildId);
    if (!channels.length) {
      await interaction.reply({ content: 'ℹ️ No channels are being tracked. Use `/activity setchannel` to add one.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `📋 **Tracked channels (${channels.length}):**\n${channels.map(id => `• <#${id}>`).join('\n')}`,
      ephemeral: true,
    });
    return;
  }

  // /activity stats
  if (sub === 'stats') {
    const target  = interaction.options.getUser('user') ?? interaction.user;
    const totals  = getUserTotals(guildId, target.id);
    const member  = await interaction.guild.members.fetch(target.id).catch(() => null);

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`📊 Activity — ${member?.displayName ?? target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: '💬 Total Messages', value: totals.totalMessages.toLocaleString(), inline: true },
        { name: '🎙 Voice Hours',    value: `${totals.totalVoiceHours.toFixed(2)}h`,  inline: true },
      );

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // /activity leaderboard
  if (sub === 'leaderboard') {
    const top = getTopUsers(guildId, 10);
    if (!top.length) {
      await interaction.reply({ content: 'ℹ️ No activity data yet.', ephemeral: true });
      return;
    }

    const lines = await Promise.all(top.map(async (u, i) => {
      const member = await interaction.guild!.members.fetch(u.userId).catch(() => null);
      const name   = member?.displayName ?? `<@${u.userId}>`;
      const medal  = ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
      return `${medal} **${name}** — ${u.totalMessages.toLocaleString()} msgs · ${u.totalVoiceHours.toFixed(1)}h voice`;
    }));

    const embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle('🏆 Activity Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: interaction.guild.name });

    await interaction.reply({ embeds: [embed] });
    return;
  }
  if (sub === 'flushvoice') {
  const now = Date.now();
  let flushed = 0;

  for (const [key, session] of voiceSessions.entries()) {
    const seconds = Math.floor((now - session.joinedAt) / 1000);
    if (seconds <= 0) continue;
    const [guildId, userId] = key.split(':');
    addVoiceSeconds(guildId, userId, seconds);
    session.joinedAt = now;
    flushed++;
  }

  await interaction.reply({
    content: `✅ Flushed voice sessions for **${flushed}** user(s).`,
    ephemeral: true,
  });
  return;
}
}
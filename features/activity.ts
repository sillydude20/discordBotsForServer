// src/features/activity.ts
// ─────────────────────────────────────────────────────────────
// Tracks per-user message counts and voice hours.
// Commands:
//   /activity stats [@user]  — show totals for a user (default: self)
//   /activity leaderboard    — top 10 by messages
//   /activity graph [days]   — server activity chart (text + voice)
// ─────────────────────────────────────────────────────────────

import {
  Client,
  VoiceState,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
  AttachmentBuilder,
  GuildMember,
} from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import {
  incrementMessageCount,
  addVoiceSeconds,
  getDailyActivity,
  getUserTotals,
  getTopUsers,
  getModlogMessagesForImport,
  importActivityCounts,
} from '../utils/database';

// ── Voice session tracking ────────────────────────────────────
// Map<`${guildId}:${userId}`, joinTimestampMs>
const voiceSessions = new Map<string, number>();

export function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const userId  = newState.id;
  const guildId = newState.guild.id;
  const key     = `${guildId}:${userId}`;

  const joinedChannel  = !oldState.channelId && newState.channelId;
  const leftChannel    = oldState.channelId  && !newState.channelId;
  const switchedChannel = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;

  if (joinedChannel) {
    voiceSessions.set(key, Date.now());
    console.log(`🎙 [voice] ${userId} joined voice in guild ${guildId}`);
    return;
  }

  if (leftChannel || switchedChannel) {
    const joined = voiceSessions.get(key);
    if (joined) {
      const seconds = Math.floor((Date.now() - joined) / 1000);
      console.log(`🎙 [voice] ${userId} left voice — ${seconds}s tracked, writing to DB`);
      if (seconds > 0) addVoiceSeconds(guildId, userId, seconds);
      voiceSessions.delete(key);
    }else {
        console.log(`🎙 [voice] ${userId} left voice but had no session tracked (bot was offline when they joined)`);
    }
    if (switchedChannel) {
      // start a new session in the new channel
      voiceSessions.set(key, Date.now());
      console.log(`🎙 [voice] ${userId} switched channels, new session started`);
    }
  }
}

// ── Graph generation ──────────────────────────────────────────

async function generateActivityGraph(
  guildId: string,
  days: number,
  guildName: string,
): Promise<Buffer> {
  const data = getDailyActivity(guildId, days);

  const W = 900, H = 500;
  const PAD = { top: 60, right: 30, bottom: 80, left: 70 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font      = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${guildName} — Activity (last ${days} days)`, W / 2, 36);

  if (data.length === 0) {
    ctx.fillStyle  = '#888';
    ctx.font       = '16px sans-serif';
    ctx.fillText('No data yet.', W / 2, H / 2);
    return canvas.toBuffer('image/png');
  }

  // Fill missing days with zeros so the x-axis is continuous
  const allDays: { date: string; totalMessages: number; totalVoiceHours: number }[] = [];
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key   = d.toISOString().slice(0, 10);
    const found = data.find(r => r.date === key);
    allDays.push(found ?? { date: key, totalMessages: 0, totalVoiceHours: 0 });
  }

  const maxMsg   = Math.max(...allDays.map(d => d.totalMessages),   1);
  const maxVoice = Math.max(...allDays.map(d => d.totalVoiceHours), 0.01);
  const n        = allDays.length;
  const barW     = Math.max(4, chartW / n - 2);

  // Grid lines (5 lines)
  ctx.strokeStyle = '#3a3b3e';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 5; i++) {
    const y = PAD.top + chartH - (chartH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + chartW, y);
    ctx.stroke();

    // Left axis label (messages)
    ctx.fillStyle  = '#aaaaaa';
    ctx.font       = '11px sans-serif';
    ctx.textAlign  = 'right';
    ctx.fillText(String(Math.round((maxMsg / 5) * i)), PAD.left - 8, y + 4);
  }
  ctx.setLineDash([]);

  // Right axis label (voice hours)
  ctx.save();
  ctx.fillStyle = '#5ba8f5';
  ctx.font      = '12px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 5; i++) {
    const y = PAD.top + chartH - (chartH / 5) * i;
    ctx.fillText(`${((maxVoice / 5) * i).toFixed(1)}h`, W - PAD.right + 42, y + 4);
  }
  ctx.restore();

  // Bars (messages — green) and line (voice — blue)
  const msgPoints:   { x: number; y: number }[] = [];
  const voicePoints: { x: number; y: number }[] = [];

  for (let i = 0; i < n; i++) {
    const d     = allDays[i];
    const x     = PAD.left + (i / n) * chartW + barW / 2;
    const barH  = (d.totalMessages / maxMsg) * chartH;
    const barY  = PAD.top + chartH - barH;
    const voiceY = PAD.top + chartH - (d.totalVoiceHours / maxVoice) * chartH;

    // Message bar
    ctx.fillStyle = d.totalMessages > 0 ? '#57f287' : '#2a2b2e';
    ctx.fillRect(x - barW / 2, barY, barW, barH);

    msgPoints.push({ x, y: barY });
    voicePoints.push({ x, y: voiceY });
  }

  // Voice line
  ctx.strokeStyle = '#5ba8f5';
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  voicePoints.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();

  // Voice dots
  ctx.fillStyle = '#5ba8f5';
  for (const p of voicePoints) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // X-axis labels — show every N days to avoid crowding
  ctx.fillStyle = '#888';
  ctx.font      = '11px sans-serif';
  ctx.textAlign = 'center';
  const labelEvery = Math.ceil(n / 14);
  for (let i = 0; i < n; i++) {
    if (i % labelEvery !== 0) continue;
    const x = PAD.left + (i / n) * chartW + barW / 2;
    ctx.fillText(allDays[i].date.slice(5), x, PAD.top + chartH + 18); // MM-DD
  }

  // Axes
  ctx.strokeStyle = '#555';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + chartH);
  ctx.lineTo(PAD.left + chartW, PAD.top + chartH);
  ctx.stroke();

  // Legend
  const lx = PAD.left + 10, ly = H - 24;
  ctx.fillStyle = '#57f287'; ctx.fillRect(lx,      ly, 14, 12);
  ctx.fillStyle = '#5ba8f5'; ctx.fillRect(lx + 90, ly, 14, 12);
  ctx.fillStyle = '#ccc'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Messages',    lx + 18,      ly + 11);
  ctx.fillText('Voice Hours', lx + 90 + 18, ly + 11);

  return canvas.toBuffer('image/png');
}

// ── Slash command ─────────────────────────────────────────────

export const activityCommand = new SlashCommandBuilder()
  .setName('activity')
  .setDescription('Server and user activity tracking')
  .addSubcommand(sub =>
    sub.setName('stats')
      .setDescription('Show message and voice stats for a user')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to check (default: yourself)').setRequired(false),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('leaderboard')
      .setDescription('Top 10 most active members'),
  )
  .addSubcommand(sub =>
  sub.setName('import')
    .setDescription('Import historical message counts from the mod-log cache into activity stats'),
)
  .addSubcommand(sub =>
    sub.setName('graph')
      .setDescription('Server activity graph')
      .addIntegerOption(opt =>
        opt.setName('days')
          .setDescription('How many days to show (default: 30, max: 90)')
          .setMinValue(7)
          .setMaxValue(90)
          .setRequired(false),
      ),
  );

// ── Interaction handler ───────────────────────────────────────

export async function handleActivityInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== 'activity') return;
  if (!interaction.guild) return;

  const sub = interaction.options.getSubcommand();

  // /activity stats
  if (sub === 'stats') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const totals = getUserTotals(interaction.guild.id, target.id);

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const embed  = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`📊 Activity — ${member?.displayName ?? target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: '💬 Total Messages', value: totals.totalMessages.toLocaleString(),    inline: true },
        { name: '🎙 Voice Hours',    value: `${totals.totalVoiceHours.toFixed(2)}h`,  inline: true },
      )
      .setFooter({ text: 'Tracking started when the bot joined' });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // /activity leaderboard
  if (sub === 'leaderboard') {
    const top    = getTopUsers(interaction.guild.id, 10);
    if (!top.length) {
      await interaction.reply({ content: 'ℹ️ No activity data yet.', ephemeral: true });
      return;
    }

    const lines = await Promise.all(top.map(async (u, i) => {
      const member = await interaction.guild!.members.fetch(u.userId).catch(() => null);
      const name   = member?.displayName ?? `<@${u.userId}>`;
      const medal  = ['🥇','🥈','🥉'][i] ?? `${i + 1}.`;
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

  // /activity graph
  if (sub === 'graph') {
    await interaction.deferReply();
    const days = interaction.options.getInteger('days') ?? 30;

    try {
      const buffer = await generateActivityGraph(
        interaction.guild.id,
        days,
        interaction.guild.name,
      );
      const file = new AttachmentBuilder(buffer, { name: 'activity.png' });
      await interaction.editReply({ files: [file] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await interaction.editReply({ content: `❌ Failed to generate graph: ${msg}` });
    }
  }
  // /activity import
if (sub === 'import') {
  await interaction.deferReply({ ephemeral: true });

  try {
    const rows = getModlogMessagesForImport(interaction.guild.id);

    if (rows.length === 0) {
      await interaction.editReply('ℹ️ No messages found in the mod-log cache for this server.');
      return;
    }

    const counts = new Map<string, number>();
    for (const row of rows) {
      const date = new Date(row.createdTimestamp).toISOString().slice(0, 10);
      const colonIndex = `${date}:${row.authorId}`.indexOf(':');
      const key = `${date}:${row.authorId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    importActivityCounts(interaction.guild.id, counts);

    const uniqueDays  = new Set([...counts.keys()].map(k => k.slice(0, 10))).size;
    const uniqueUsers = new Set([...counts.keys()].map(k => k.slice(11))).size;

    await interaction.editReply(
      `✅ Import complete.\n` +
      `**${rows.length.toLocaleString()}** messages processed\n` +
      `**${uniqueUsers}** unique users\n` +
      `**${uniqueDays}** days of history\n\n` +
      `You can now use \`/activity graph\` and \`/activity leaderboard\`.`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`❌ Import failed: ${msg}`);
  }
}
}
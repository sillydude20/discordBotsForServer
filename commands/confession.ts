// src/commands/confession.ts
// ─────────────────────────────────────────────────────────────
// Commands:
//   /confession post <message>  — anonymously post a confession
//   /confession setchannel      — set where confessions are posted
//   /confession removechannel   — disable confessions
//   /confession status          — show current config
// ─────────────────────────────────────────────────────────────

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(__dirname, '../../data/bot.db'));

// ── Create table if it doesn't exist ─────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS confession_config (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS confession_count (
    guild_id TEXT PRIMARY KEY,
    count    INTEGER NOT NULL DEFAULT 0
  );
`);

// ── DB helpers ────────────────────────────────────────────────

function getConfessionChannel(guildId: string): string | null {
  const row = db.prepare('SELECT channel_id FROM confession_config WHERE guild_id = ?').get(guildId) as any;
  return row?.channel_id ?? null;
}

function saveConfessionChannel(guildId: string, channelId: string): void {
  db.prepare(`
    INSERT INTO confession_config (guild_id, channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
  `).run(guildId, channelId);
}

function deleteConfessionChannel(guildId: string): void {
  db.prepare('DELETE FROM confession_config WHERE guild_id = ?').run(guildId);
}

function incrementAndGetCount(guildId: string): number {
  db.prepare(`
    INSERT INTO confession_count (guild_id, count) VALUES (?, 1)
    ON CONFLICT(guild_id) DO UPDATE SET count = count + 1
  `).run(guildId);
  const row = db.prepare('SELECT count FROM confession_count WHERE guild_id = ?').get(guildId) as any;
  return row?.count ?? 1;
}

// ── Slash command ─────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName('confession')
  .setDescription('Anonymous confessions')
  .addSubcommand((sub) =>
    sub
      .setName('post')
      .setDescription('Post an anonymous confession')
      .addStringOption((opt) =>
        opt
          .setName('message')
          .setDescription('Your confession (completely anonymous)')
          .setRequired(true)
          .setMaxLength(1800),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('setchannel')
      .setDescription('Set the channel where confessions are posted')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Confession channel').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('removechannel').setDescription('Disable confessions in this server'),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show the current confession channel'),
  );

// ── Confession number → label ─────────────────────────────────

function confessionLabel(n: number): string {
  return `Confession #${n}`;
}

// ── Random flare ──────────────────────────────────────────────
// Gives each confession a subtle unique colour and emoji header
// without revealing anything about the author.

const FLARE_COLORS = [
  0xe8405a, // red
  0xff7043, // deep orange
  0xffa726, // orange
  0xffee58, // yellow
  0x66bb6a, // green
  0x26c6da, // cyan
  0x42a5f5, // blue
  0x7e57c2, // purple
  0xec407a, // pink
  0x8d6e63, // brown
];

const FLARE_ICONS = ['🌙', '🔮', '🕯️', '🌊', '🌸', '⚡', '🦋', '🎭', '🌹', '✨', '🫧', '🌀'];

function randomFlare(seed: number): { color: number; icon: string } {
  return {
    color: FLARE_COLORS[seed % FLARE_COLORS.length],
    icon:  FLARE_ICONS[seed % FLARE_ICONS.length],
  };
}

// ── Execute ───────────────────────────────────────────────────

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // /confession setchannel
  if (sub === 'setchannel') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '❌ You need the **Manage Server** permission to set the confession channel.', ephemeral: true });
      return;
    }

    const channel = interaction.options.getChannel('channel', true);
    saveConfessionChannel(interaction.guild.id, channel.id);
    await interaction.reply({
      content: `✅ Confession channel set to <#${channel.id}>. Members can now use \`/confession post\` anywhere.`,
      ephemeral: true,
    });
    return;
  }

  // /confession removechannel
  if (sub === 'removechannel') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '❌ You need the **Manage Server** permission to do this.', ephemeral: true });
      return;
    }

    deleteConfessionChannel(interaction.guild.id);
    await interaction.reply({ content: '🗑 Confession channel removed. Confessions are now disabled.', ephemeral: true });
    return;
  }

  // /confession status
  if (sub === 'status') {
    const channelId = getConfessionChannel(interaction.guild.id);
    if (!channelId) {
      await interaction.reply({ content: 'ℹ️ Confessions are not configured. Use `/confession setchannel` to set one up.', ephemeral: true });
      return;
    }
    await interaction.reply({ content: `📋 Confessions are being posted to <#${channelId}>.`, ephemeral: true });
    return;
  }

  // /confession post
  if (sub === 'post') {
    const channelId = getConfessionChannel(interaction.guild.id);
    if (!channelId) {
      await interaction.reply({
        content: '❌ Confessions are not set up in this server. Ask an admin to use `/confession setchannel`.',
        ephemeral: true,
      });
      return;
    }

    const message = interaction.options.getString('message', true).trim();

    if (message.length < 1) {
      await interaction.reply({ content: '❌ Your confession cannot be empty.', ephemeral: true });
      return;
    }

    // Acknowledge immediately — ephemeral so nothing leaks in the channel it was used
    await interaction.reply({
      content: '✅ Your confession has been posted anonymously.',
      ephemeral: true,
    });

    try {
      const confessionChannel = await interaction.guild.channels.fetch(channelId);
      if (!confessionChannel || !confessionChannel.isTextBased()) return;

      const count = incrementAndGetCount(interaction.guild.id);
      const flare = randomFlare(count);

      const embed = new EmbedBuilder()
        .setColor(flare.color)
        .setTitle(`${flare.icon} ${confessionLabel(count)}`)
        .setDescription(message)
        .setTimestamp()
        .setFooter({ text: 'Posted anonymously' });

      await (confessionChannel as TextChannel).send({ embeds: [embed] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[confession] Failed to post confession: ${msg}`);
    }
  }
}
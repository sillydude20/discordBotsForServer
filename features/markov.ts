// src/features/markov.ts
// ─────────────────────────────────────────────────────────────
// Commands:
//   /markov enable #channel   — learn from messages in a channel
//   /markov disable #channel  — stop learning from a channel
//   /markov generate          — generate a message from stored data
//   /markov autoset <n>       — auto-generate every N messages (0 = off)
//   /markov import            — import existing mod-log cache (enabled channels only)
//   /markov wipe              — delete all stored messages for this server
//   /markov status            — show current config and message count
//
// NOTE: Reply-to-bot detection is handled in index.ts.
//       This module only handles: saving messages from enabled channels
//       and auto-interval generation. It also exports generateMarkov()
//       so index.ts can call it directly.
// ─────────────────────────────────────────────────────────────

import {
  Client,
  Message,
  TextChannel,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import Markov from 'markov-strings';
import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(__dirname, '../../data/bot.db'));

// ── Tables ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS markov_enabled_channels (
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS markov_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    content    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS markov_config (
    guild_id      TEXT PRIMARY KEY,
    auto_interval INTEGER NOT NULL DEFAULT 0
  );
`);

// ── In-memory ─────────────────────────────────────────────────
const enabledChannels = new Set<string>(); // channelId
const autoIntervals   = new Map<string, number>(); // guildId → every N messages
const messageCounts   = new Map<string, number>(); // guildId → count since last gen

// ── Load from DB on startup ───────────────────────────────────
export function loadMarkovConfig(): void {
  const channels = db.prepare('SELECT channel_id FROM markov_enabled_channels').all() as any[];
  enabledChannels.clear();
  for (const row of channels) enabledChannels.add(row.channel_id);

  const configs = db.prepare('SELECT guild_id, auto_interval FROM markov_config').all() as any[];
  autoIntervals.clear();
  for (const row of configs) {
    if (row.auto_interval > 0) autoIntervals.set(row.guild_id, row.auto_interval);
  }

  console.log(`📦 Loaded ${enabledChannels.size} markov channel(s) from database`);
}

// ── DB helpers ────────────────────────────────────────────────

function saveMessage(guildId: string, channelId: string, content: string): void {
  db.prepare('INSERT INTO markov_messages (guild_id, channel_id, content) VALUES (?, ?, ?)')
    .run(guildId, channelId, content);
}

function getMessages(guildId: string): string[] {
  return (db.prepare('SELECT content FROM markov_messages WHERE guild_id = ?').all(guildId) as any[])
    .map(r => r.content);
}

function getMessageCount(guildId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM markov_messages WHERE guild_id = ?').get(guildId) as any;
  return row?.count ?? 0;
}

function wipeMessages(guildId: string): void {
  db.prepare('DELETE FROM markov_messages WHERE guild_id = ?').run(guildId);
}

function getEnabledChannelsForGuild(guildId: string): string[] {
  return (db.prepare('SELECT channel_id FROM markov_enabled_channels WHERE guild_id = ?')
    .all(guildId) as any[]).map(r => r.channel_id);
}

// ── Generate text ─────────────────────────────────────────────

/**
 * Generate a markov string for the given guild.
 * Returns null if there isn't enough data yet.
 */
export function generateMarkov(guildId: string): string | null {
  const messages = getMessages(guildId);
  if (messages.length < 10) return null;

  try {
    const markov = new Markov({ stateSize: 2 });
    markov.addData(messages);
    const result = markov.generate({
      maxTries: 20,
      filter: (r) => r.string.length > 10 && r.refs.length > 1,
    });
    return result.string;
  } catch {
    return null;
  }
}

// ── Handle incoming messages ──────────────────────────────────
// Only saves content from enabled channels and handles auto-interval.
// Does NOT handle bot replies — that's index.ts's job.

export async function handleMarkovMessage(message: Message, client: Client): Promise<void> {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content || message.content.length < 5) return;
  if (message.content.startsWith('/')) return;

  // Only process enabled channels
  if (!enabledChannels.has(message.channelId)) return;

  saveMessage(message.guild.id, message.channelId, message.content);

  // Auto-interval generation
  const interval = autoIntervals.get(message.guild.id);
  if (interval && interval > 0) {
    const count = (messageCounts.get(message.guild.id) ?? 0) + 1;
    messageCounts.set(message.guild.id, count);

    if (count >= interval) {
      messageCounts.set(message.guild.id, 0);
      const generated = generateMarkov(message.guild.id);
      if (generated) {
        await (message.channel as TextChannel).send(generated);
      }
    }
  }
}

// ── Slash command ─────────────────────────────────────────────

export const markovCommand = new SlashCommandBuilder()
  .setName('markov')
  .setDescription('AI message generation based on server messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub.setName('enable')
      .setDescription('Allow the bot to learn from messages in a channel')
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Channel to learn from').setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('disable')
      .setDescription('Stop learning from a channel')
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Channel to stop learning from').setRequired(true),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('generate')
      .setDescription('Generate a message based on server history'),
  )
  .addSubcommand(sub =>
    sub.setName('autoset')
      .setDescription('Auto-generate a message every N messages sent in enabled channels')
      .addIntegerOption(opt =>
        opt.setName('interval')
          .setDescription('Generate every N messages (0 to disable)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(1000),
      ),
  )
  .addSubcommand(sub =>
    sub.setName('import')
      .setDescription('Import messages already stored by the mod-log cache (enabled channels only)'),
  )
  .addSubcommand(sub =>
    sub.setName('wipe')
      .setDescription('Delete all stored messages for this server'),
  )
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show current markov config and message count'),
  );

// ── Interaction handler ───────────────────────────────────────

export async function handleMarkovInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== 'markov') return;
  if (!interaction.guild) return;

  const sub = interaction.options.getSubcommand();

  // /markov enable
  if (sub === 'enable') {
    const channel = interaction.options.getChannel('channel', true);
    db.prepare('INSERT OR IGNORE INTO markov_enabled_channels (guild_id, channel_id) VALUES (?, ?)')
      .run(interaction.guild.id, channel.id);
    enabledChannels.add(channel.id);
    await interaction.reply({
      content: `✅ Now learning from messages in <#${channel.id}>.\n\nTip: use \`/markov import\` to pull in messages already stored by the mod-log.`,
      ephemeral: true,
    });
    return;
  }

  // /markov disable
  if (sub === 'disable') {
    const channel = interaction.options.getChannel('channel', true);
    db.prepare('DELETE FROM markov_enabled_channels WHERE guild_id = ? AND channel_id = ?')
      .run(interaction.guild.id, channel.id);
    enabledChannels.delete(channel.id);
    await interaction.reply({
      content: `✅ No longer learning from <#${channel.id}>. Existing stored messages are kept — use \`/markov wipe\` to clear everything.`,
      ephemeral: true,
    });
    return;
  }

  // /markov generate
  if (sub === 'generate') {
    await interaction.deferReply();
    const generated = generateMarkov(interaction.guild.id);
    if (!generated) {
      await interaction.editReply('❌ Not enough messages collected yet. Enable some channels and wait for more messages, or use `/markov import`.');
      return;
    }
    await interaction.editReply(generated);
    return;
  }

  // /markov autoset
  if (sub === 'autoset') {
    const interval = interaction.options.getInteger('interval', true);
    db.prepare(`
      INSERT INTO markov_config (guild_id, auto_interval) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET auto_interval = excluded.auto_interval
    `).run(interaction.guild.id, interval);

    if (interval === 0) {
      autoIntervals.delete(interaction.guild.id);
      await interaction.reply({ content: '✅ Auto-generation disabled.', ephemeral: true });
    } else {
      autoIntervals.set(interaction.guild.id, interval);
      messageCounts.set(interaction.guild.id, 0);
      await interaction.reply({
        content: `✅ Will auto-generate a message every **${interval}** messages sent in enabled channels.`,
        ephemeral: true,
      });
    }
    return;
  }

  // /markov import
  if (sub === 'import') {
    await interaction.deferReply({ ephemeral: true });

    const enabledForGuild = getEnabledChannelsForGuild(interaction.guild.id);
    if (enabledForGuild.length === 0) {
      await interaction.editReply('❌ No channels are enabled for markov learning. Use `/markov enable` first.');
      return;
    }

    const existing = new Set(
      (db.prepare('SELECT content FROM markov_messages WHERE guild_id = ?')
        .all(interaction.guild.id) as any[]).map(r => r.content),
    );

    const placeholders = enabledForGuild.map(() => '?').join(', ');
    const rows = (db.prepare(`
      SELECT channel_id, content FROM modlog_message_cache
      WHERE guild_id = ?
      AND channel_id IN (${placeholders})
      AND content != ''
      AND length(content) >= 5
    `).all(interaction.guild.id, ...enabledForGuild) as any[]);

    if (rows.length === 0) {
      await interaction.editReply('ℹ️ No messages found in the mod-log cache for your enabled channels.');
      return;
    }

    let imported = 0, skipped = 0;
    const insert = db.prepare('INSERT INTO markov_messages (guild_id, channel_id, content) VALUES (?, ?, ?)');
    const importMany = db.transaction((rows: any[]) => {
      for (const row of rows) {
        if (existing.has(row.content) || row.content.startsWith('/')) { skipped++; continue; }
        insert.run(interaction.guild!.id, row.channel_id, row.content);
        existing.add(row.content);
        imported++;
      }
    });
    importMany(rows);

    const total = getMessageCount(interaction.guild.id);
    await interaction.editReply(
      `✅ Import complete.\n**${imported}** messages imported from **${enabledForGuild.length}** enabled channel(s).\n` +
      `**${skipped}** skipped (already stored or filtered).\n**${total}** total messages now available.`,
    );
    return;
  }

  // /markov wipe
  if (sub === 'wipe') {
    wipeMessages(interaction.guild.id);
    await interaction.reply({ content: '🗑 All stored messages wiped for this server.', ephemeral: true });
    return;
  }

  // /markov status
  if (sub === 'status') {
    const count    = getMessageCount(interaction.guild.id);
    const interval = autoIntervals.get(interaction.guild.id) ?? 0;
    const channels = getEnabledChannelsForGuild(interaction.guild.id)
      .map(id => `<#${id}>`).join(', ') || '*None*';

    const quality = count < 10   ? '❌ Too few messages — generation will fail'
                  : count < 50   ? '⚠️ Low — results may be poor'
                  : count < 200  ? '🟡 Decent — getting there'
                  : '✅ Good';

    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle('🤖 Markov Config')
      .addFields(
        { name: 'Enabled Channels', value: channels },
        { name: 'Stored Messages',  value: `${count}`, inline: true },
        { name: 'Auto Interval',    value: interval > 0 ? `Every ${interval} messages` : 'Disabled', inline: true },
        { name: 'Data Quality',     value: quality },
      )
      .setFooter({ text: 'Use /markov import to pull in existing mod-log data' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}
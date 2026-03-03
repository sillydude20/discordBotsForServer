// src/features/autodelete.ts
// ─────────────────────────────────────────────────────────────
// Rules are persisted in bot.db and survive restarts.
// ─────────────────────────────────────────────────────────────

import {
  Client,
  ChatInputCommandInteraction,
  Message,
  TextChannel,
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  FetchMessagesOptions,
  Collection,
  Snowflake,
} from 'discord.js';
import {
  getAutoDeleteRules,
  saveAutoDeleteRule,
  deleteAutoDeleteRule,
} from '../utils/database';

// ── Types ─────────────────────────────────────────────────────

interface AutoDeleteRule {
  guildId: string;
  delayMs: number;
  label: string;
}

type DurationUnit = 's' | 'm' | 'h' | 'd';

const MULTIPLIERS: Record<DurationUnit, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// ── In-memory cache (loaded from DB on startup) ───────────────
const autoDeleteRules = new Map<string, AutoDeleteRule>();

export async function loadAutoDeleteRules(): Promise<void> {
  const rows = await getAutoDeleteRules();
  autoDeleteRules.clear();
  for (const row of rows) {
    autoDeleteRules.set(row.channelId, {
      guildId: row.guildId,
      delayMs: row.delayMs,
      label: row.label,
    });
  }
  console.log(`📦 Loaded ${autoDeleteRules.size} auto-delete rule(s) from database`);
}

// ── Duration helpers ──────────────────────────────────────────

export function parseDuration(str: string): number | null {
  const match = str.trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase() as DurationUnit;
  return value * MULTIPLIERS[unit];
}

export function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000)  return `${ms / 3_600_000}h`;
  if (ms >= 60_000)     return `${ms / 60_000}m`;
  return `${ms / 1_000}s`;
}

// ── Slash command definition ──────────────────────────────────

export const autoDeleteCommand = new SlashCommandBuilder()
  .setName('autodelete')
  .setDescription('Manage per-channel auto-delete rules')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Enable auto-delete in a channel')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Target channel').setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('duration')
          .setDescription('Delete messages older than this (e.g. 30s, 5m, 2h, 7d)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Disable auto-delete in a channel')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Target channel').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List all active auto-delete rules in this server'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('purge')
      .setDescription('Immediately delete all messages in a channel')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Target channel').setRequired(true),
      ),
  );

// ── Command registration ──────────────────────────────────────

export async function registerAutoDeleteCommands(
  token: string,
  clientId: string,
  guildId?: string,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = [autoDeleteCommand.toJSON()];
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
  }
}

// ── Bulk-delete helper ────────────────────────────────────────

async function bulkDeleteChannel(channel: TextChannel): Promise<number> {
  let deleted = 0;
  const TWO_WEEKS = 14 * 86_400_000 - 60_000;

  while (true) {
    const fetched: Collection<Snowflake, Message> = await channel.messages.fetch({ limit: 100 });
    if (!fetched.size) break;

    const recent = fetched.filter((m) => Date.now() - m.createdTimestamp < TWO_WEEKS);
    const old    = fetched.filter((m) => Date.now() - m.createdTimestamp >= TWO_WEEKS);

    if (recent.size > 1) {
      const result = await channel.bulkDelete(recent, true);
      deleted += result.size;
    } else if (recent.size === 1) {
      await recent.first()!.delete();
      deleted++;
    }
    for (const msg of old.values()) {
      try { await msg.delete(); deleted++; await sleep(1_100); } catch { /* skip */ }
    }
    if (fetched.size < 100) break;
  }
  return deleted;
}

// ── Sweep: delete messages older than delayMs ─────────────────

async function sweepChannel(channel: TextChannel, delayMs: number): Promise<number> {
  const cutoff = Date.now() - delayMs;
  const TWO_WEEKS = 14 * 86_400_000 - 60_000;
  let deleted = 0;
  let before: Snowflake | undefined;

  while (true) {
    const options: FetchMessagesOptions = { limit: 100 };
    if (before) options.before = before;

    const fetched: Collection<Snowflake, Message> = await channel.messages.fetch(options);
    if (!fetched.size) break;

    const toDelete = fetched.filter((m) => m.createdTimestamp < cutoff);
    const recent   = toDelete.filter((m) => Date.now() - m.createdTimestamp < TWO_WEEKS);
    const old      = toDelete.filter((m) => Date.now() - m.createdTimestamp >= TWO_WEEKS);

    if (recent.size > 1) {
      const result = await channel.bulkDelete(recent, true);
      deleted += result.size;
    } else if (recent.size === 1) {
      await recent.first()!.delete();
      deleted++;
    }
    for (const msg of old.values()) {
      try { await msg.delete(); deleted++; } catch { /* skip */ }
      await sleep(1_100);
    }

    before = fetched.last()?.id;
    if (fetched.size < 100) break;
  }
  return deleted;
}

// ── Sweep loop ────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 60_000;

export function startSweepLoop(client: Client): void {
  setInterval(async () => {
    for (const [channelId, rule] of autoDeleteRules.entries()) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          autoDeleteRules.delete(channelId);
          await deleteAutoDeleteRule(channelId);
          continue;
        }
        const count = await sweepChannel(channel as TextChannel, rule.delayMs);
        if (count > 0) {
          console.log(`🗑  Swept ${count} messages from #${(channel as TextChannel).name} (rule: ${rule.label})`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Sweep failed for channel ${channelId}:`, msg);
      }
    }
  }, SWEEP_INTERVAL_MS);

  console.log(`🔁 Auto-delete sweep loop running every ${SWEEP_INTERVAL_MS / 1_000}s`);
}

// ── Real-time deletion on message arrival ─────────────────────

export function handleMessage(message: Message): void {
  if (message.author.bot) return;
  const rule = autoDeleteRules.get(message.channelId);
  if (!rule) return;

  setTimeout(async () => {
    try {
      const msg = await message.channel.messages.fetch(message.id).catch(() => null);
      if (msg) await msg.delete();
    } catch { /* already deleted */ }
  }, rule.delayMs);
}

// ── Interaction handler ───────────────────────────────────────

export async function handleAutoDeleteInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== 'autodelete') return;

  const sub = interaction.options.getSubcommand();

  // /autodelete set
  if (sub === 'set') {
    const channel     = interaction.options.getChannel('channel', true);
    const durationStr = interaction.options.getString('duration', true);
    const delayMs     = parseDuration(durationStr);

    if (!delayMs) {
      await interaction.reply({ content: '❌ Invalid duration. Use formats like `30s`, `5m`, `2h`, `1d`.', ephemeral: true });
      return;
    }
    if (delayMs < 5_000) {
      await interaction.reply({ content: '❌ Minimum duration is **5 seconds**.', ephemeral: true });
      return;
    }

    const rule: AutoDeleteRule = {
      guildId: interaction.guildId ?? '',
      delayMs,
      label: formatDuration(delayMs),
    };

    autoDeleteRules.set(channel.id, rule);
    await saveAutoDeleteRule(channel.id, rule.guildId, rule.delayMs, rule.label);

    await interaction.reply({
      content: `✅ Auto-delete enabled in <#${channel.id}>. Messages will be deleted after **${rule.label}**.`,
      ephemeral: true,
    });
    return;
  }

  // /autodelete remove
  if (sub === 'remove') {
    const channel = interaction.options.getChannel('channel', true);

    if (!autoDeleteRules.has(channel.id)) {
      await interaction.reply({ content: `ℹ️ No auto-delete rule found for <#${channel.id}>.`, ephemeral: true });
      return;
    }

    autoDeleteRules.delete(channel.id);
    await deleteAutoDeleteRule(channel.id);

    await interaction.reply({ content: `🗑 Auto-delete disabled for <#${channel.id}>.`, ephemeral: true });
    return;
  }

  // /autodelete list
  if (sub === 'list') {
    const guildRules = [...autoDeleteRules.entries()].filter(
      ([, rule]) => rule.guildId === interaction.guildId,
    );

    if (!guildRules.length) {
      await interaction.reply({ content: 'ℹ️ No auto-delete rules configured for this server.', ephemeral: true });
      return;
    }

    const lines = guildRules.map(
      ([channelId, rule]) => `• <#${channelId}> — delete after **${rule.label}**`,
    );

    await interaction.reply({
      content: `**Auto-delete rules (${guildRules.length}):**\n${lines.join('\n')}`,
      ephemeral: true,
    });
    return;
  }

  // /autodelete purge
  if (sub === 'purge') {
    const channel = interaction.options.getChannel('channel', true);
    await interaction.deferReply({ ephemeral: true });

    try {
      const textChannel = await interaction.guild?.channels.fetch(channel.id);
      if (!textChannel || !textChannel.isTextBased()) {
        await interaction.editReply({ content: '❌ That channel is not a text channel.' });
        return;
      }
      const count = await bulkDeleteChannel(textChannel as TextChannel);
      await interaction.editReply({ content: `🗑 Purged **${count}** messages from <#${channel.id}>.` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await interaction.editReply({ content: `❌ Failed to purge: ${msg}` });
    }
  }
}

// ── Utility ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
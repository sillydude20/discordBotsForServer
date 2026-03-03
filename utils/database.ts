import Database from "better-sqlite3";
import path from "path";

// Single DB file — easy to copy to a VPS later
const db = new Database(path.join(__dirname, "../../data/bot.db"));

// Run once on startup to create tables
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS starboard_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      threshold INTEGER NOT NULL DEFAULT 3,
      allowed_channels TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS starboard_messages (
      message_id TEXT PRIMARY KEY,
      starboard_message_id TEXT NOT NULL,
      guild_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS modlog_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autodelete_rules (
      channel_id TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      delay_ms   INTEGER NOT NULL,
      label      TEXT NOT NULL
    );
  `);
}
initDatabase();

// ─── Types ───────────────────────────────────────────────

export interface StarboardConfig {
  channelId: string;
  threshold: number;
  allowedChannels: string[];
}

export interface AutoDeleteRow {
  channelId: string;
  guildId: string;
  delayMs: number;
  label: string;
}

// ─── Starboard Config ────────────────────────────────────

export function getStarboardConfig(guildId: string): StarboardConfig | null {
  const row = db.prepare("SELECT * FROM starboard_config WHERE guild_id = ?").get(guildId) as any;
  if (!row) return null;
  return {
    channelId: row.channel_id,
    threshold: row.threshold,
    allowedChannels: JSON.parse(row.allowed_channels),
  };
}

export function setStarboardConfig(guildId: string, config: StarboardConfig) {
  db.prepare(`
    INSERT INTO starboard_config (guild_id, channel_id, threshold, allowed_channels)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      threshold = excluded.threshold,
      allowed_channels = excluded.allowed_channels
  `).run(guildId, config.channelId, config.threshold, JSON.stringify(config.allowedChannels));
}

// ─── Starboard Messages ──────────────────────────────────

export function getExistingStarboardMessage(messageId: string): { starboardMessageId: string } | null {
  const row = db.prepare("SELECT * FROM starboard_messages WHERE message_id = ?").get(messageId) as any;
  if (!row) return null;
  return { starboardMessageId: row.starboard_message_id };
}

export function saveStarboardMessage(messageId: string, starboardMessageId: string, guildId: string) {
  db.prepare(`
    INSERT OR IGNORE INTO starboard_messages (message_id, starboard_message_id, guild_id)
    VALUES (?, ?, ?)
  `).run(messageId, starboardMessageId, guildId);
}

// ─── Auto-delete Rules ───────────────────────────────────

export function getAutoDeleteRules(): AutoDeleteRow[] {
  return (db.prepare("SELECT channel_id, guild_id, delay_ms, label FROM autodelete_rules").all() as any[])
    .map((row) => ({
      channelId: row.channel_id,
      guildId:   row.guild_id,
      delayMs:   row.delay_ms,
      label:     row.label,
    }));
}

export function saveAutoDeleteRule(
  channelId: string,
  guildId: string,
  delayMs: number,
  label: string,
): void {
  db.prepare(`
    INSERT INTO autodelete_rules (channel_id, guild_id, delay_ms, label)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      delay_ms = excluded.delay_ms,
      label    = excluded.label
  `).run(channelId, guildId, delayMs, label);
}

export function deleteAutoDeleteRule(channelId: string): void {
  db.prepare("DELETE FROM autodelete_rules WHERE channel_id = ?").run(channelId);
}

// ─── Mod-log Config ──────────────────────────────────────

export interface ModLogRow {
  guildId: string;
  channelId: string;
}

export function getModLogConfig(): ModLogRow[] {
  return (db.prepare("SELECT guild_id, channel_id FROM modlog_config").all() as any[])
    .map((row) => ({
      guildId:   row.guild_id,
      channelId: row.channel_id,
    }));
}

export function saveModLogConfig(guildId: string, channelId: string): void {
  db.prepare(`
    INSERT INTO modlog_config (guild_id, channel_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
  `).run(guildId, channelId);
}

export function deleteModLogConfig(guildId: string): void {
  db.prepare("DELETE FROM modlog_config WHERE guild_id = ?").run(guildId);
}
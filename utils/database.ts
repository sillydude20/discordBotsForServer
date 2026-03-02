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
  `);
}

initDatabase();

// ─── Types ───────────────────────────────────────────────

export interface StarboardConfig {
  channelId: string;
  threshold: number;
  allowedChannels: string[];
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
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
    CREATE TABLE IF NOT EXISTS modlog_ignored_channels (
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS modlog_message_cache (
      message_id        TEXT PRIMARY KEY,
      author_id         TEXT NOT NULL,
      author_tag        TEXT NOT NULL,
      author_avatar     TEXT NOT NULL,
      channel_id        TEXT NOT NULL,
      guild_id          TEXT NOT NULL,
      content           TEXT NOT NULL DEFAULT '',
      created_timestamp INTEGER NOT NULL,
      attachments       TEXT NOT NULL DEFAULT '[]',
      reply_to_id       TEXT
    );
    CREATE TABLE IF NOT EXISTS modlog_log_map (
      message_id     TEXT PRIMARY KEY,
      log_message_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS booster_roles (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      role_id  TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS booster_showcase_channel (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS booster_cards (
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS admin_roles (
      guild_id TEXT PRIMARY KEY,
      role_id  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autodelete_rules (
      channel_id TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      delay_ms   INTEGER NOT NULL,
      label      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS modlog_cmdlog_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autodelete_ignored_messages (
      message_id TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_stats (
      guild_id    TEXT NOT NULL,
      date        TEXT NOT NULL,   -- 'YYYY-MM-DD'
      user_id     TEXT NOT NULL,
      msg_count   INTEGER NOT NULL DEFAULT 0,
      voice_secs  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, date, user_id)
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

// ─── Mod-log Ignored Channels ────────────────────────────────

export function getModLogIgnoredChannels(): { guildId: string; channelId: string }[] {
  return (db.prepare("SELECT guild_id, channel_id FROM modlog_ignored_channels").all() as any[])
    .map((row) => ({ guildId: row.guild_id, channelId: row.channel_id }));
}

export function addModLogIgnoredChannel(guildId: string, channelId: string): void {
  db.prepare("INSERT OR IGNORE INTO modlog_ignored_channels (guild_id, channel_id) VALUES (?, ?)")
    .run(guildId, channelId);
}

export function removeModLogIgnoredChannel(guildId: string, channelId: string): void {
  db.prepare("DELETE FROM modlog_ignored_channels WHERE guild_id = ? AND channel_id = ?")
    .run(guildId, channelId);
}

// ─── Mod-log Message Cache ───────────────────────────────────

export interface CachedMessageRow {
  messageId: string;
  authorId: string;
  authorTag: string;
  authorAvatar: string;
  channelId: string;
  guildId: string;
  content: string;
  createdTimestamp: number;
  attachments: string; // JSON string
  replyToId: string | null;
}

export function getCachedMessages(): CachedMessageRow[] {
  return (db.prepare("SELECT * FROM modlog_message_cache").all() as any[]).map((row) => ({
    messageId:        row.message_id,
    authorId:         row.author_id,
    authorTag:        row.author_tag,
    authorAvatar:     row.author_avatar,
    channelId:        row.channel_id,
    guildId:          row.guild_id,
    content:          row.content,
    createdTimestamp: row.created_timestamp,
    attachments:      row.attachments,
    replyToId:        row.reply_to_id,
  }));
}

export function saveCachedMessage(messageId: string, data: {
  authorId: string; authorTag: string; authorAvatar: string;
  channelId: string; guildId: string; content: string;
  createdTimestamp: number;
  attachments: { name: string; url: string; contentType: string | null }[];
  replyToId?: string;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO modlog_message_cache
      (message_id, author_id, author_tag, author_avatar, channel_id, guild_id,
       content, created_timestamp, attachments, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    messageId, data.authorId, data.authorTag, data.authorAvatar,
    data.channelId, data.guildId, data.content, data.createdTimestamp,
    JSON.stringify(data.attachments), data.replyToId ?? null,
  );
}

export function deleteCachedMessage(messageId: string): void {
  db.prepare("DELETE FROM modlog_message_cache WHERE message_id = ?").run(messageId);
}

// ─── Mod-log Message Map ─────────────────────────────────────

export function getLogMessageMap(): { messageId: string; logMessageId: string }[] {
  return (db.prepare("SELECT message_id, log_message_id FROM modlog_log_map").all() as any[])
    .map((row) => ({ messageId: row.message_id, logMessageId: row.log_message_id }));
}

export function saveLogMessageMap(messageId: string, logMessageId: string): void {
  db.prepare("INSERT OR REPLACE INTO modlog_log_map (message_id, log_message_id) VALUES (?, ?)")
    .run(messageId, logMessageId);
}

export function deleteLogMessageMap(messageId: string): void {
  db.prepare("DELETE FROM modlog_log_map WHERE message_id = ?").run(messageId);
}

// ─── Booster Roles ───────────────────────────────────────────

export interface BoosterRoleRow {
  guildId: string;
  userId: string;
  roleId: string;
}

export function getBoosterRole(guildId: string, userId: string): BoosterRoleRow | null {
  const row = db.prepare(
    "SELECT guild_id, user_id, role_id FROM booster_roles WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId) as any;
  if (!row) return null;
  return { guildId: row.guild_id, userId: row.user_id, roleId: row.role_id };
}

export function saveBoosterRole(guildId: string, userId: string, roleId: string): void {
  db.prepare(`
    INSERT INTO booster_roles (guild_id, user_id, role_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET role_id = excluded.role_id
  `).run(guildId, userId, roleId);
}

export function deleteBoosterRole(guildId: string, userId: string): void {
  db.prepare("DELETE FROM booster_roles WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
}

export function getAllBoosterRoles(guildId: string): BoosterRoleRow[] {
  return (db.prepare("SELECT guild_id, user_id, role_id FROM booster_roles WHERE guild_id = ?").all(guildId) as any[])
    .map((row) => ({ guildId: row.guild_id, userId: row.user_id, roleId: row.role_id }));
}

// ─── Admin Roles ─────────────────────────────────────────────

export function getAdminRole(): { guildId: string; roleId: string }[] {
  return (db.prepare("SELECT guild_id, role_id FROM admin_roles").all() as any[])
    .map((row) => ({ guildId: row.guild_id, roleId: row.role_id }));
}

export function saveAdminRole(guildId: string, roleId: string): void {
  db.prepare(`
    INSERT INTO admin_roles (guild_id, role_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET role_id = excluded.role_id
  `).run(guildId, roleId);
}

export function deleteAdminRole(guildId: string): void {
  db.prepare("DELETE FROM admin_roles WHERE guild_id = ?").run(guildId);
}

// ─── Booster Showcase Channel ────────────────────────────────

export function getBoosterShowcaseChannel(guildId: string): string | null {
  const row = db.prepare(
    "SELECT channel_id FROM booster_showcase_channel WHERE guild_id = ?"
  ).get(guildId) as any;
  return row?.channel_id ?? null;
}

export function saveBoosterShowcaseChannel(guildId: string, channelId: string): void {
  db.prepare(`
    INSERT INTO booster_showcase_channel (guild_id, channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
  `).run(guildId, channelId);
}

// ─── Booster Cards ───────────────────────────────────────────

export function getBoosterCard(guildId: string, userId: string): string | null {
  const row = db.prepare(
    "SELECT message_id FROM booster_cards WHERE guild_id = ? AND user_id = ?"
  ).get(guildId, userId) as any;
  return row?.message_id ?? null;
}

export function saveBoosterCard(guildId: string, userId: string, messageId: string): void {
  db.prepare(`
    INSERT INTO booster_cards (guild_id, user_id, message_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET message_id = excluded.message_id
  `).run(guildId, userId, messageId);
}

export function deleteBoosterCard(guildId: string, userId: string): void {
  db.prepare("DELETE FROM booster_cards WHERE guild_id = ? AND user_id = ?").run(guildId, userId);
}

// ─── Mod-log Command Log Channel ─────────────────────────────

export function getCmdLogConfig(): { guildId: string; channelId: string }[] {
  return (db.prepare("SELECT guild_id, channel_id FROM modlog_cmdlog_config").all() as any[])
    .map((row) => ({ guildId: row.guild_id, channelId: row.channel_id }));
}

export function saveCmdLogConfig(guildId: string, channelId: string): void {
  db.prepare(`
    INSERT INTO modlog_cmdlog_config (guild_id, channel_id)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
  `).run(guildId, channelId);
}

export function deleteCmdLogConfig(guildId: string): void {
  db.prepare("DELETE FROM modlog_cmdlog_config WHERE guild_id = ?").run(guildId);
}

// ─── Auto-delete Ignored Messages ────────────────────────────

export function getAutoDeleteIgnoredMessages(): { messageId: string; guildId: string }[] {
  return (db.prepare("SELECT message_id, guild_id FROM autodelete_ignored_messages").all() as any[])
    .map((row) => ({ messageId: row.message_id, guildId: row.guild_id }));
}

export function saveAutoDeleteIgnoredMessage(messageId: string, guildId: string): void {
  db.prepare("INSERT OR IGNORE INTO autodelete_ignored_messages (message_id, guild_id) VALUES (?, ?)")
    .run(messageId, guildId);
}

export function deleteAutoDeleteIgnoredMessage(messageId: string): void {
  db.prepare("DELETE FROM autodelete_ignored_messages WHERE message_id = ?").run(messageId);
}


// ─── Activity Stats ──────────────────────────────────────────

export function incrementMessageCount(guildId: string, userId: string): void {
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO activity_stats (guild_id, date, user_id, msg_count, voice_secs)
    VALUES (?, ?, ?, 1, 0)
    ON CONFLICT(guild_id, date, user_id) DO UPDATE SET msg_count = msg_count + 1
  `).run(guildId, userId, date);
}

export function addVoiceSeconds(guildId: string, userId: string, seconds: number): void {
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO activity_stats (guild_id, date, user_id, msg_count, voice_secs)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(guild_id, date, user_id) DO UPDATE SET voice_secs = voice_secs + ?
  `).run(guildId, userId, date, seconds, seconds);
}

export interface DailyActivity {
  date: string;
  totalMessages: number;
  totalVoiceHours: number;
}

export function getDailyActivity(guildId: string, days: number): DailyActivity[] {
  return (db.prepare(`
    SELECT date,
           SUM(msg_count)  AS total_messages,
           SUM(voice_secs) AS total_voice_secs
    FROM activity_stats
    WHERE guild_id = ?
      AND date >= date('now', ? || ' days')
    GROUP BY date
    ORDER BY date ASC
  `).all(guildId, `-${days}`) as any[]).map(row => ({
    date:            row.date,
    totalMessages:   row.total_messages,
    totalVoiceHours: Math.round(row.total_voice_secs / 36) / 100, // 2 decimal hours
  }));
}

export interface UserTotals {
  userId: string;
  totalMessages: number;
  totalVoiceHours: number;
}

export function getUserTotals(guildId: string, userId: string): UserTotals {
  const row = db.prepare(`
    SELECT SUM(msg_count)  AS total_messages,
           SUM(voice_secs) AS total_voice_secs
    FROM activity_stats
    WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId) as any;
  return {
    userId,
    totalMessages:   row?.total_messages   ?? 0,
    totalVoiceHours: Math.round((row?.total_voice_secs ?? 0) / 36) / 100,
  };
}

export function getTopUsers(guildId: string, limit = 10): UserTotals[] {
  return (db.prepare(`
    SELECT user_id,
           SUM(msg_count)  AS total_messages,
           SUM(voice_secs) AS total_voice_secs
    FROM activity_stats
    WHERE guild_id = ?
    GROUP BY user_id
    ORDER BY total_messages DESC
    LIMIT ?
  `).all(guildId, limit) as any[]).map(row => ({
    userId:          row.user_id,
    totalMessages:   row.total_messages,
    totalVoiceHours: Math.round(row.total_voice_secs / 36) / 100,
  }));
}

// ─── Starboard Message Deletion ──────────────────────────────

export function getAllStarboardMessages(guildId: string): { messageId: string; starboardMessageId: string }[] {
  return (db.prepare("SELECT message_id, starboard_message_id FROM starboard_messages WHERE guild_id = ?")
    .all(guildId) as any[])
    .map(row => ({ messageId: row.message_id, starboardMessageId: row.starboard_message_id }));
}

export function deleteStarboardMessage(messageId: string): void {
  db.prepare("DELETE FROM starboard_messages WHERE message_id = ?").run(messageId);
}

export function getCachedMessageById(messageId: string): CachedMessageRow | null {
  const row = db.prepare("SELECT * FROM modlog_message_cache WHERE message_id = ?").get(messageId) as any;
  if (!row) return null;
  return {
    messageId:        row.message_id,
    authorId:         row.author_id,
    authorTag:        row.author_tag,
    authorAvatar:     row.author_avatar,
    channelId:        row.channel_id,
    guildId:          row.guild_id,
    content:          row.content,
    createdTimestamp: row.created_timestamp,
    attachments:      row.attachments,
    replyToId:        row.reply_to_id,
  };
}

// ─── Activity Import Helpers ─────────────────────────────────

export function getModlogMessagesForImport(guildId: string): { authorId: string; createdTimestamp: number }[] {
  return (db.prepare(`
    SELECT author_id, created_timestamp
    FROM modlog_message_cache
    WHERE guild_id = ?
  `).all(guildId) as any[]).map(row => ({
    authorId:         row.author_id,
    createdTimestamp: row.created_timestamp,
  }));
}

export function importActivityCounts(guildId: string, counts: Map<string, number>): void {
  const upsert = db.prepare(`
    INSERT INTO activity_stats (guild_id, date, user_id, msg_count, voice_secs)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(guild_id, date, user_id) DO UPDATE SET
      msg_count = msg_count + excluded.msg_count
  `);

  const importAll = db.transaction(() => {
    for (const [key, count] of counts) {
      const colonIndex = key.indexOf(':');
      const date   = key.slice(0, colonIndex);
      const userId = key.slice(colonIndex + 1);
      upsert.run(guildId, date, userId, count);
    }
  });

  importAll();
}

export function getTopUsersFromCache(guildId: string, limit = 10): { userId: string; totalMessages: number }[] {
  return (db.prepare(`
    SELECT author_id, COUNT(*) as total_messages
    FROM modlog_message_cache
    WHERE guild_id = ?
    GROUP BY author_id
    ORDER BY total_messages DESC
    LIMIT ?
  `).all(guildId, limit) as any[]).map(row => ({
    userId: row.author_id,
    totalMessages: row.total_messages,
  }));
}
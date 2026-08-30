const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'musikbot.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    dj_role_id TEXT,
    is_247 INTEGER NOT NULL DEFAULT 0,
    volume INTEGER NOT NULL DEFAULT 100,
    music_channel_id TEXT,
    music_panel_msg_id TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS song_stats (
    guild_id TEXT NOT NULL,
    track_uri TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    play_count INTEGER NOT NULL DEFAULT 1,
    last_played TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, track_uri)
);
`);

// Every individual play, as opposed to song_stats which only keeps a running
// counter per track. Without this the timestamp and requester of each play are
// lost the moment the counter is incremented, which rules out anything
// time-based (year in review, weekly trends) or per-person.
// requested_by is null for tracks the bot queued itself (AutoMix / 24-7).
db.exec(`
CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    track_uri TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    requested_by TEXT,
    played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_play_history_time       ON play_history(played_at);
CREATE INDEX IF NOT EXISTS idx_play_history_guild_time ON play_history(guild_id, played_at);
CREATE INDEX IF NOT EXISTS idx_play_history_user_time  ON play_history(requested_by, played_at);
`);

// Add columns if they don't exist yet (for existing DBs after migration).
for (const col of [
    'ALTER TABLE guild_settings ADD COLUMN music_channel_id TEXT',
    'ALTER TABLE guild_settings ADD COLUMN music_panel_msg_id TEXT',
    'ALTER TABLE guild_settings ADD COLUMN voice_channel_id TEXT',
    'ALTER TABLE guild_settings ADD COLUMN log_channel_id TEXT',
]) {
    try { db.exec(col); } catch { /* already exists */ }
}

// Titel, die sich dauerhaft nicht abspielen lassen (praktisch immer, weil
// YouTube fuer sie eine Anmeldung verlangt). Ohne diese Liste versucht der Bot
// bei jedem Durchlauf aufs Neue dieselben Titel und scheitert wieder.
db.exec(`
CREATE TABLE IF NOT EXISTS blocked_tracks (
    identifier TEXT PRIMARY KEY,
    uri        TEXT,
    title      TEXT,
    author     TEXT,
    reason     TEXT,
    blocked_at TEXT NOT NULL,
    attempts   INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_blocked_at ON blocked_tracks(blocked_at);
`);

module.exports = { db, DB_PATH };

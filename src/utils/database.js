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

// Add columns if they don't exist yet (for existing DBs after migration).
for (const col of [
    'ALTER TABLE guild_settings ADD COLUMN music_channel_id TEXT',
    'ALTER TABLE guild_settings ADD COLUMN music_panel_msg_id TEXT',
    'ALTER TABLE guild_settings ADD COLUMN voice_channel_id TEXT',
    'ALTER TABLE guild_settings ADD COLUMN log_channel_id TEXT',
]) {
    try { db.exec(col); } catch { /* already exists */ }
}

module.exports = { db, DB_PATH };

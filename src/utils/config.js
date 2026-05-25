const fs = require('fs');
const path = require('path');
const { db } = require('./database');

const SETTINGS_PATH = path.join(__dirname, '../../data/guildSettings.json');
const DEFAULT_GUILD_SETTINGS = {
    djRoleId: null,
    is247: false,
    volume: 100,
    musicChannelId: null,
    musicPanelMsgId: null,
    voiceChannelId: null,
    logChannelId: null,
};

const getStmt = db.prepare(`
SELECT guild_id, dj_role_id, is_247, volume, music_channel_id, music_panel_msg_id, voice_channel_id, log_channel_id
FROM guild_settings
WHERE guild_id = ?
`);

const upsertStmt = db.prepare(`
INSERT INTO guild_settings (guild_id, dj_role_id, is_247, volume, music_channel_id, music_panel_msg_id, voice_channel_id, log_channel_id, updated_at)
VALUES (@guild_id, @dj_role_id, @is_247, @volume, @music_channel_id, @music_panel_msg_id, @voice_channel_id, @log_channel_id, CURRENT_TIMESTAMP)
ON CONFLICT(guild_id) DO UPDATE SET
    dj_role_id = excluded.dj_role_id,
    is_247 = excluded.is_247,
    volume = excluded.volume,
    music_channel_id = excluded.music_channel_id,
    music_panel_msg_id = excluded.music_panel_msg_id,
    voice_channel_id = excluded.voice_channel_id,
    log_channel_id = excluded.log_channel_id,
    updated_at = CURRENT_TIMESTAMP
`);

const countStmt = db.prepare('SELECT COUNT(*) as c FROM guild_settings');

function migrateLegacyJsonIfNeeded() {
    const row = countStmt.get();
    if ((row?.c || 0) > 0) return;
    if (!fs.existsSync(SETTINGS_PATH)) return;

    try {
        const legacy = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        const entries = Object.entries(legacy || {});
        if (entries.length === 0) return;

        const tx = db.transaction((items) => {
            for (const [guildId, settings] of items) {
                upsertStmt.run({
                    guild_id: String(guildId),
                    dj_role_id: settings?.djRoleId || null,
                    is_247: settings?.is247 ? 1 : 0,
                    volume: Number.isFinite(settings?.volume) ? Math.max(0, Math.min(150, settings.volume)) : 100,
                });
            }
        });

        tx(entries);
    } catch {
        // Keep startup resilient if legacy file is malformed.
    }
}

migrateLegacyJsonIfNeeded();

function getGuildSettings(guildId) {
    const row = getStmt.get(String(guildId));
    if (!row) return { ...DEFAULT_GUILD_SETTINGS };

    return {
        djRoleId: row.dj_role_id || null,
        is247: Boolean(row.is_247),
        volume: Number.isFinite(row.volume) ? Math.max(0, Math.min(150, row.volume)) : 100,
        musicChannelId: row.music_channel_id || null,
        musicPanelMsgId: row.music_panel_msg_id || null,
        voiceChannelId: row.voice_channel_id || null,
        logChannelId: row.log_channel_id || null,
    };
}

function setGuildSettings(guildId, update) {
    const current = getGuildSettings(guildId);
    const merged = { ...DEFAULT_GUILD_SETTINGS, ...current, ...(update || {}) };

    upsertStmt.run({
        guild_id: String(guildId),
        dj_role_id: merged.djRoleId || null,
        is_247: merged.is247 ? 1 : 0,
        volume: Number.isFinite(merged.volume) ? Math.max(0, Math.min(150, merged.volume)) : 100,
        music_channel_id: merged.musicChannelId || null,
        music_panel_msg_id: merged.musicPanelMsgId || null,
        voice_channel_id: merged.voiceChannelId || null,
        log_channel_id: merged.logChannelId || null,
    });
}

const recordPlayStmt = db.prepare(`
    INSERT INTO song_stats (guild_id, track_uri, title, author, play_count, last_played)
    VALUES (@guild_id, @track_uri, @title, @author, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, track_uri) DO UPDATE SET
        play_count = play_count + 1,
        title = excluded.title,
        author = excluded.author,
        last_played = CURRENT_TIMESTAMP
`);

function recordPlay(guildId, trackInfo) {
    if (!trackInfo?.uri || trackInfo.isStream) return; // skip radio streams
    try {
        recordPlayStmt.run({
            guild_id: String(guildId),
            track_uri: trackInfo.uri,
            title: (trackInfo.title || 'Unknown').slice(0, 255),
            author: (trackInfo.author || '').slice(0, 255),
        });
    } catch { /* non-critical */ }
}

const topSongsStmt = db.prepare(`
    SELECT title, author, play_count, last_played
    FROM song_stats
    WHERE guild_id = ?
    ORDER BY play_count DESC
    LIMIT 10
`);

function getTopSongs(guildId) {
    return topSongsStmt.all(String(guildId));
}

const lastPlayedStmt = db.prepare(`
    SELECT track_uri, title, author, last_played
    FROM song_stats
    WHERE guild_id = ?
    ORDER BY last_played DESC
    LIMIT 1
`);

function getLastPlayedSong(guildId) {
    return lastPlayedStmt.get(String(guildId)) || null;
}

const getAllIs247Stmt = db.prepare(`
    SELECT guild_id, voice_channel_id, music_channel_id, volume
    FROM guild_settings
    WHERE is_247 = 1 AND voice_channel_id IS NOT NULL
`);

function getAllIs247Guilds() {
    return getAllIs247Stmt.all();
}

module.exports = { getGuildSettings, setGuildSettings, DEFAULT_GUILD_SETTINGS, recordPlay, getTopSongs, getAllIs247Guilds, getLastPlayedSong };

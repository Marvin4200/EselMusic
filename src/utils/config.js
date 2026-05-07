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
};

const getStmt = db.prepare(`
SELECT guild_id, dj_role_id, is_247, volume, music_channel_id, music_panel_msg_id
FROM guild_settings
WHERE guild_id = ?
`);

const upsertStmt = db.prepare(`
INSERT INTO guild_settings (guild_id, dj_role_id, is_247, volume, music_channel_id, music_panel_msg_id, updated_at)
VALUES (@guild_id, @dj_role_id, @is_247, @volume, @music_channel_id, @music_panel_msg_id, CURRENT_TIMESTAMP)
ON CONFLICT(guild_id) DO UPDATE SET
    dj_role_id = excluded.dj_role_id,
    is_247 = excluded.is_247,
    volume = excluded.volume,
    music_channel_id = excluded.music_channel_id,
    music_panel_msg_id = excluded.music_panel_msg_id,
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
    });
}

module.exports = { getGuildSettings, setGuildSettings, DEFAULT_GUILD_SETTINGS };

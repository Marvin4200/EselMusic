const { formatDuration } = require('./formatDuration');

/** @type {Map<string, PlayerState>} guildId → state */
const players = new Map();

/**
 * @typedef {Object} PlayerState
 * @property {import('shoukaku').Player} player
 * @property {any[]} queue
 * @property {any|null} current
 * @property {'none'|'track'|'queue'} loop
 * @property {number} volume
 * @property {import('discord.js').TextChannel} textChannel
 * @property {boolean} is247
 */

function buildNowPlayingEmbed(track) {
    const thumbnail = track.info.artworkUrl
        || (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/mqdefault.jpg` : null);

    return {
        color: 0x5865F2,
        title: '🎵 Now Playing',
        description: `**[${track.info.title}](${track.info.uri})**`,
        fields: [
            { name: 'Artist', value: track.info.author || 'Unknown', inline: true },
            { name: 'Duration', value: track.info.isStream ? 'LIVE 🔴' : formatDuration(track.info.length), inline: true },
        ],
        ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
    };
}

async function playNext(guildId, { silent = false } = {}) {
    const state = players.get(guildId);
    if (!state) return;

    let next = null;

    if (state.loop === 'track' && state.current) {
        next = state.current;
    } else {
        if (state.loop === 'queue' && state.current) {
            state.queue.push(state.current);
        }
        next = state.queue.shift() || null;
    }

    if (!next) {
        state.current = null;
        if (state.is247) return;
        try {
            state.player.connection.disconnect();
        } catch { }
        players.delete(guildId);
        state.textChannel?.send({ embeds: [{ color: 0x5865F2, description: '✅ Queue ended. Leaving voice channel.' }] }).catch(() => { });
        return;
    }

    state.current = next;

    try {
        await state.player.playTrack({ track: { encoded: next.encoded } });
        if (!silent) {
            state.textChannel?.send({ embeds: [buildNowPlayingEmbed(next)] }).catch(() => { });
        }
    } catch (err) {
        console.error('[PlayerManager] playNext error:', err);
        state.textChannel?.send({ embeds: [{ color: 0xED4245, description: `❌ Failed to play track, skipping...` }] }).catch(() => { });
        await playNext(guildId);
    }
}

/**
 * Get or create a guild player. Reuses existing player if already connected.
 */
async function createGuildPlayer({ guildId, voiceChannelId, shardId, textChannel, shoukaku }) {
    const existing = players.get(guildId);
    if (existing) {
        existing.textChannel = textChannel;
        return existing;
    }

    const player = await shoukaku.joinVoiceChannel({
        guildId,
        channelId: voiceChannelId,
        shardId,
        deaf: true,
    });

    /** @type {PlayerState} */
    const state = {
        player,
        queue: [],
        current: null,
        loop: 'none',
        volume: 100,
        textChannel,
        is247: false,
    };

    players.set(guildId, state);

    player.on('end', async (data) => {
        if (data.reason === 'replaced') return;
        if (data.reason === 'cleanup') {
            players.delete(guildId);
            return;
        }
        await playNext(guildId);
    });

    player.on('exception', async (error) => {
        console.error(`[Player] Exception in guild ${guildId}:`, error?.message || error);
        state.textChannel?.send({ embeds: [{ color: 0xED4245, description: '❌ Track error, skipping...' }] }).catch(() => { });
        await playNext(guildId);
    });

    player.on('closed', () => {
        players.delete(guildId);
    });

    return state;
}

function destroyPlayer(guildId, shoukaku) {
    const state = players.get(guildId);
    if (!state) return;
    try {
        shoukaku.leaveVoiceChannel(guildId);
    } catch { }
    players.delete(guildId);
}

module.exports = { players, createGuildPlayer, playNext, destroyPlayer, buildNowPlayingEmbed };

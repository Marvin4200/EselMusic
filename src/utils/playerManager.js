const { formatDuration } = require('./formatDuration');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getGuildSettings, setGuildSettings, recordPlay, getLastPlayedSong } = require('./config');
const { buildBrandPayload } = require('./brandAssets');
const { updateMusicPanel } = require('./musicPanel');

/** @type {import('discord.js').Client|null} */
let _client = null;
function setDiscordClient(c) { _client = c; }

/** @type {import('shoukaku').Shoukaku|null} */
let _shoukaku = null;
function setShoukaku(s) { _shoukaku = s; }

/** @type {Map<string, NodeJS.Timeout>} guildId → refresh interval */
const refreshIntervals = new Map();
/** @type {Map<string, NodeJS.Timeout>} guildId → 24/7 retry timeout */
const automixRetryTimeouts = new Map();
/** @type {Map<string, string[]>} guildId → recently played URIs (last 25) */
const recentlyPlayedUris = new Map();
/** @type {Map<string, string[]>} guildId → recently played authors (last 10) */
const recentlyPlayedAuthors = new Map();
const RECENTLY_PLAYED_MAX = 25;
const RECENTLY_PLAYED_AUTHORS_MAX = 10;
/** Max times the same author may appear in the last 10 before being skipped */
const MAX_AUTHOR_REPEATS = 2;

// Diverse seed artists for AutoMix rotation — one picked at random when current artist is over-represented
const AUTOMIX_SEED_ARTISTS = [
    'Capital Bra', 'Bonez MC', 'Apache 207', 'Luciano', 'Samra', 'Ufo361',
    'Pashanim', 'Bausa', 'Badmomzjay', 'Nimo', 'Gzuz', 'RAF Camora',
    'Haftbefehl', 'Bushido', 'Kollegah', 'Farid Bang', 'Mero', 'Zuna',
    'Yung Hurn', 'Sido', 'Cro', 'K.I.Z', 'SSio', 'Maxwell',
];

function addRecentUri(guildId, uri, author) {
    if (!uri) return;
    // Track URI
    const uriList = recentlyPlayedUris.get(guildId) || [];
    if (!uriList.includes(uri)) {
        uriList.push(uri);
        if (uriList.length > RECENTLY_PLAYED_MAX) uriList.shift();
        recentlyPlayedUris.set(guildId, uriList);
    }
    // Track author
    if (author) {
        const authorList = recentlyPlayedAuthors.get(guildId) || [];
        authorList.push(author.toLowerCase());
        if (authorList.length > RECENTLY_PLAYED_AUTHORS_MAX) authorList.shift();
        recentlyPlayedAuthors.set(guildId, authorList);
    }
}

function getOverusedAuthors(guildId) {
    const list = recentlyPlayedAuthors.get(guildId) || [];
    const counts = {};
    for (const a of list) counts[a] = (counts[a] || 0) + 1;
    return new Set(Object.entries(counts).filter(([, n]) => n >= MAX_AUTHOR_REPEATS).map(([a]) => a));
}

function pickDiverseSeedArtist(guildId) {
    const overused = getOverusedAuthors(guildId);
    const available = AUTOMIX_SEED_ARTISTS.filter(a => !overused.has(a.toLowerCase()));
    const pool = available.length > 0 ? available : AUTOMIX_SEED_ARTISTS;
    return pool[Math.floor(Math.random() * pool.length)];
}

const AUTOPLAY_RETRY_MS = 15_000;
const DEUTSCHRAP_HINT = 'deutschrap';
const DEUTSCHRAP_KEYWORDS = [
    'deutschrap', 'deutsch rap', 'german rap', 'german hip hop', 'hip hop deutsch',
    // Labels & crews
    '187', 'aggro berlin', 'urban', 'urban recordings',
    // Artists — well-known Deutschrap acts
    'haftbefehl', 'bonez mc', 'raf camora', 'capital bra', 'samra', 'luciano',
    'ufo361', 'apache 207', 'pashanim', 'loredana', 'nimo', 'animus', 'xatar',
    'mero', 'ali as', 'bushido', 'farid bang', 'kollegah', 'sido', 'kool savas',
    'mach one', 'samy deluxe', 'fler', 'eko fresh', 'taktloss', 'ssio', 'az izz',
    'gzuz', 'maxwell', 'nate57', 'kalim', 'morad', 'bausa', 'badmomzjay',
    'zuna', 'manuellsen', 'yung hurn', 'k.i.z', 'kiz', 'tarek', 'ottah',
    'hashinshin', 'capo', 'veysel', 'cro', 'punch arabus', 'sun diego',
    // Slang / scene terms that appear in titles
    'deutschrap', 'diggah', 'ehrenmann', 'ghetto', 'strasse', 'straße',
    'berlin', 'wien', 'zürich', 'hamburg', 'köln', 'frankfurt', 'stuttgart',
];

function startPanelRefresh(guildId) {
    stopPanelRefresh(guildId);
    const interval = setInterval(() => {
        if (!_client) return;
        const state = players.get(guildId);
        if (!state?.current) { stopPanelRefresh(guildId); return; }
        updateMusicPanel(_client, guildId, state).catch(() => { });
    }, 15_000);
    refreshIntervals.set(guildId, interval);
}

function stopPanelRefresh(guildId) {
    const existing = refreshIntervals.get(guildId);
    if (existing) { clearInterval(existing); refreshIntervals.delete(guildId); }
}

/** Send a message that auto-deletes after `ms` milliseconds (default 10s). */
function sendTemp(channel, payload, ms = 10_000) {
    if (!channel) return;
    channel.send(payload)
        .then(msg => setTimeout(() => msg.delete().catch(() => { }), ms))
        .catch(() => { });
}

function clearAutomixRetry(guildId) {
    const timeout = automixRetryTimeouts.get(guildId);
    if (timeout) {
        clearTimeout(timeout);
        automixRetryTimeouts.delete(guildId);
    }
}

function scheduleAutomixRetry(guildId) {
    clearAutomixRetry(guildId);
    const timeout = setTimeout(() => {
        automixRetryTimeouts.delete(guildId);
        const state = players.get(guildId);
        if (!state || !state.is247) return;
        if (state.current || state.queue.length > 0) return;
        playNext(guildId, { silent: true }).catch(() => { });
    }, AUTOPLAY_RETRY_MS);
    automixRetryTimeouts.set(guildId, timeout);
}

async function getRelatedTrackFor247(guildId) {
    if (!_shoukaku) return null;
    const node = _shoukaku.getIdealNode();
    if (!node) return null;

    const last = getLastPlayedSong(guildId);
    if (!last?.title) return null;

    const overusedAuthors = getOverusedAuthors(guildId);
    const lastAuthorOverused = last.author && overusedAuthors.has(last.author.toLowerCase());

    // When the current artist is over-represented, inject a diverse seed as first query
    const diverseSeed = pickDiverseSeedArtist(guildId);
    const base = `${last.title} ${last.author || ''}`.trim();
    const identifiers = lastAuthorOverused
        ? [
            `ytmsearch:${diverseSeed} ${DEUTSCHRAP_HINT}`,
            `ytmsearch:${base} ${DEUTSCHRAP_HINT} mix`,
            `ytsearch:${base} ${DEUTSCHRAP_HINT} related`,
            `ytmsearch:${DEUTSCHRAP_HINT} mix`,
        ]
        : [
            `ytmsearch:${base} ${DEUTSCHRAP_HINT} mix`,
            `ytsearch:${base} ${DEUTSCHRAP_HINT} related`,
            `ytsearch:${base} ${DEUTSCHRAP_HINT}`,
            `ytmsearch:${DEUTSCHRAP_HINT} mix`,
        ];

    for (const identifier of identifiers) {
        try {
            const resolved = await node.rest.resolve(identifier);
            if (!resolved || resolved.loadType !== 'search' || !Array.isArray(resolved.data) || resolved.data.length === 0) {
                continue;
            }

            const candidates = resolved.data.slice(0, 15);
            const seenUris = recentlyPlayedUris.get(guildId) || [];
            const deutschrapCandidates = candidates.filter((t) => {
                const text = `${t?.info?.title || ''} ${t?.info?.author || ''}`.toLowerCase();
                return DEUTSCHRAP_KEYWORDS.some(k => text.includes(k));
            });
            // Strict: only pick from confirmed Deutschrap results.
            if (deutschrapCandidates.length === 0) continue;
            // Prefer tracks from artists not over-represented and not seen recently
            const picked =
                deutschrapCandidates.find(t => t?.info?.uri && !seenUris.includes(t.info.uri) && !overusedAuthors.has((t.info.author || '').toLowerCase()))
                ?? deutschrapCandidates.find(t => t?.info?.uri && !seenUris.includes(t.info.uri))
                ?? deutschrapCandidates.find(t => t?.info?.uri && t.info.uri !== last.track_uri)
                ?? null;
            if (picked) return { track: picked, seed: last };
        } catch {
            // Try next fallback query.
        }
    }

    return null;
}

async function getFallbackDeutschrapTrackFor247() {
    if (!_shoukaku) return null;
    const node = _shoukaku.getIdealNode();
    if (!node) return null;

    const fallbackQueries = [
        'ytmsearch:deutschrap mix',
        'ytsearch:deutschrap 2026',
        'ytsearch:german rap playlist',
    ];

    for (const query of fallbackQueries) {
        try {
            const resolved = await node.rest.resolve(query);
            if (!resolved || resolved.loadType !== 'search' || !Array.isArray(resolved.data) || resolved.data.length === 0) continue;

            const candidates = resolved.data.slice(0, 15);
            const track = candidates.find((t) => {
                const text = `${t?.info?.title || ''} ${t?.info?.author || ''}`.toLowerCase();
                return DEUTSCHRAP_KEYWORDS.some(k => text.includes(k));
            });
            // Strict: skip this query if nothing matches Deutschrap.
            if (!track) continue;
            if (track.info) {
                track.info.author = track.info.author || 'Deutschrap AutoMix';
            }
            return track;
        } catch {
            // Try next fallback query.
        }
    }

    return null;
}

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

function buildPlayerControlsRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music:pause').setLabel('Pause/Resume').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    );
}

async function applyPlayerVolume(player, level) {
    if (typeof player.setGlobalVolume === 'function') {
        await player.setGlobalVolume(level);
        return;
    }
    if (typeof player.setVolume === 'function') {
        await player.setVolume(level);
        return;
    }
    if (typeof player.update === 'function') {
        await player.update({ volume: level });
        return;
    }
    throw new Error('Volume control is not supported by the current player implementation');
}

async function tryRecoverTrack(guildId, state, shoukaku) {
    const failedTrack = state.current;
    if (!failedTrack?.info) return false;

    const key = failedTrack.info.identifier
        || failedTrack.info.uri
        || `${failedTrack.info.title}|${failedTrack.info.author || ''}`;

    const retries = state.retryCounts.get(key) || 0;
    if (retries >= 1) return false;

    const node = shoukaku.getIdealNode();
    if (!node) return false;

    const query = `${failedTrack.info.title} ${failedTrack.info.author || ''}`.trim();
    const identifiers = [`ytmsearch:${query}`, `ytsearch:${query}`];

    for (const identifier of identifiers) {
        try {
            const resolved = await node.rest.resolve(identifier);
            if (!resolved || resolved.loadType !== 'search' || !Array.isArray(resolved.data) || resolved.data.length === 0) {
                continue;
            }

            const recovered = resolved.data[0];
            state.retryCounts.set(key, retries + 1);
            state.current = recovered;

            state.textChannel?.send({
                embeds: [{ color: 0xFEE75C, description: `⚠️ Playback error on **${failedTrack.info.title}**. Retrying with an alternative source...` }],
            }).catch(() => { });

            await state.player.playTrack({ track: { encoded: recovered.encoded } });
            if (_client) updateMusicPanel(_client, guildId, state).catch(() => { });
            sendTemp(state.textChannel, {
                ...buildBrandPayload(buildNowPlayingEmbed(recovered), { includeBanner: true }),
                components: [buildPlayerControlsRow()],
            });
            return true;
        } catch {
            // Try next fallback identifier
        }
    }

    return false;
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
        stopPanelRefresh(guildId);
        if (_client) updateMusicPanel(_client, guildId, null).catch(() => { });
        if (state.is247) {
            clearAutomixRetry(guildId);
            const related = await getRelatedTrackFor247(guildId);
            if (related?.track) {
                state.queue.push(related.track);
                sendTemp(state.textChannel, {
                    embeds: [{ color: 0x5865F2, description: `🔁 **24/7 AutoMix**: Verwandter Song zu **${related.seed.title}** geladen.` }],
                });
                return playNext(guildId, { silent: true });
            }

            const fallbackTrack = await getFallbackDeutschrapTrackFor247();
            if (fallbackTrack) {
                state.queue.push(fallbackTrack);
                sendTemp(state.textChannel, {
                    embeds: [{ color: 0x5865F2, description: '🎤 **24/7 Deutschrap AutoMix**: Keine direkten Related-Songs gefunden, nutze Deutschrap-Fallback.' }],
                });
                return playNext(guildId, { silent: true });
            }

            sendTemp(state.textChannel, {
                embeds: [{ color: 0xFEE75C, description: '⚠️ 24/7 Deutschrap aktiv, Quelle gerade nicht erreichbar. Neuer Versuch in 15s...' }],
            });
            scheduleAutomixRetry(guildId);
            return;
        }
        try {
            state.player.connection.disconnect();
        } catch { }
        players.delete(guildId);
        sendTemp(state.textChannel, { embeds: [{ color: 0x5865F2, description: '✅ Queue ended. Leaving voice channel.' }] });
        return;
    }

    state.current = next;

    try {
        clearAutomixRetry(guildId);
        await state.player.playTrack({ track: { encoded: next.encoded } });
        recordPlay(guildId, next.info);
        addRecentUri(guildId, next.info?.uri, next.info?.author);
        startPanelRefresh(guildId);
        if (_client) updateMusicPanel(_client, guildId, state).catch(() => { });
        if (!silent) {
            sendTemp(state.textChannel, {
                ...buildBrandPayload(buildNowPlayingEmbed(next), { includeBanner: true }),
                components: [buildPlayerControlsRow()],
            });
        }
    } catch (err) {
        console.error('[PLAYER_001] playNext error:', err);
        sendTemp(state.textChannel, { embeds: [{ color: 0xED4245, description: '❌ Failed to play track, skipping...' }] });
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

    // Clear stale guild connection handles before creating a fresh player.
    if (shoukaku.players?.has(guildId)) {
        try {
            shoukaku.leaveVoiceChannel(guildId);
        } catch { }
        await new Promise(resolve => setTimeout(resolve, 350));
    }

    let player = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            player = await shoukaku.joinVoiceChannel({
                guildId,
                channelId: voiceChannelId,
                shardId,
                deaf: true,
            });
            break;
        } catch (err) {
            lastError = err;
            const message = err?.message || '';
            const isExisting = message.includes('already have an existing connection');
            const noNodes = message.includes("Can't find any nodes to connect on");

            if (isExisting) {
                try {
                    shoukaku.leaveVoiceChannel(guildId);
                } catch { }
            }

            if ((isExisting || noNodes) && attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            throw err;
        }
    }

    if (!player) {
        throw lastError || new Error('Failed to create voice connection');
    }

    const settings = getGuildSettings(guildId);

    // Persist the voice channel so 24/7 can rejoin after restart/kick
    setGuildSettings(guildId, { voiceChannelId });

    /** @type {PlayerState & { retryCounts: Map<string, number> }} */
    const state = {
        player,
        queue: [],
        current: null,
        loop: 'none',
        volume: Number.isFinite(settings.volume) ? Math.max(0, Math.min(150, settings.volume)) : 100,
        textChannel,
        is247: Boolean(settings.is247),
        retryCounts: new Map(),
    };

    players.set(guildId, state);

    try {
        await applyPlayerVolume(player, state.volume);
    } catch (err) {
        console.warn('[PLAYER_002] Failed to apply initial volume:', err?.message || err);
    }

    player.on('end', async (data) => {
        if (data.reason === 'replaced') return;
        if (data.reason === 'cleanup') {
            players.delete(guildId);
            return;
        }
        await playNext(guildId);
    });

    player.on('exception', async (error) => {
        if (!players.has(guildId)) return;
        console.error(`[PLAYER_003] Exception in guild ${guildId}:`, error?.message || error);

        const recovered = await tryRecoverTrack(guildId, state, shoukaku);
        if (recovered) return;

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
    stopPanelRefresh(guildId);
    clearAutomixRetry(guildId);
    recentlyPlayedUris.delete(guildId);
    recentlyPlayedAuthors.delete(guildId);
    try {
        shoukaku.leaveVoiceChannel(guildId);
    } catch { }
    players.delete(guildId);
}

module.exports = {
    players,
    createGuildPlayer,
    playNext,
    destroyPlayer,
    buildNowPlayingEmbed,
    buildPlayerControlsRow,
    applyPlayerVolume,
    setDiscordClient,
    setShoukaku,
};

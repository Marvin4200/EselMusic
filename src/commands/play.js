const { SlashCommandBuilder } = require('discord.js');
const https = require('https');
const { createGuildPlayer, playNext, players, searchIdentifiers } = require('../utils/playerManager');
const { formatDuration } = require('../utils/formatDuration');
const { buildBrandPayload } = require('../utils/brandAssets');

/** Fetch Spotify track metadata from the embed page JSON (no auth required).
 *  Returns a YouTube search query string like "Track Title Artist1, Artist2", or null on failure. */
function resolveSpotifyUrl(url) {
    // Normalize URL: strip /intl-XX/ prefix and query params
    const match = url.match(/spotify\.com(?:\/intl-[a-z]+)?\/track\/([A-Za-z0-9]+)/);
    if (!match) return Promise.resolve(null);
    const trackId = match[1];
    const embedUrl = `https://open.spotify.com/embed/track/${trackId}`;

    return new Promise((resolve) => {
        const req = https.get(embedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; EselMusic-Bot/1.0)',
                'Accept': 'text/html',
            }
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; if (data.length > 200_000) { req.destroy(); resolve(null); } });
            res.on('end', () => {
                try {
                    // The embed page embeds a <script> with the full track JSON
                    const scriptMatch = data.match(/<script[^>]*>(\{"props":\{"pageProps":.+?)<\/script>/);
                    if (!scriptMatch) return resolve(null);
                    const json = JSON.parse(scriptMatch[1]);
                    const entity = json?.props?.pageProps?.state?.data?.entity;
                    if (!entity || entity.type !== 'track') return resolve(null);
                    const title = (entity.name || '').trim();
                    if (!title) return resolve(null);
                    const artists = (entity.artists || []).map(a => a.name).filter(Boolean).join(', ');
                    return resolve(artists ? `${title} ${artists}` : title);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song or add it to the queue')
        .addStringOption(opt =>
            opt.setName('query')
                .setDescription('Song name, YouTube URL, or Spotify URL')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction, { shoukaku }) {
        const focused = interaction.options.getFocused();
        if (!focused || focused.length < 2) {
            return interaction.respond([]);
        }
        try {
            const node = shoukaku.getIdealNode();
            if (!node) return interaction.respond([]);

            // Dieselbe Quellen-Reihenfolge wie beim eigentlichen Abspielen.
            // Sonst schlägt der Bot hier YouTube-Treffer vor, deren URL dann
            // direkt aufgelöst wird — und der Quellen-Umschalter greift nie.
            const [preferred] = searchIdentifiers(focused);
            const resolved = await node.rest.resolve(preferred);
            if (!resolved || resolved.loadType !== 'search' || !Array.isArray(resolved.data)) {
                return interaction.respond([]);
            }

            const choices = resolved.data.slice(0, 8).map(t => ({
                name: `${t.info.title} — ${t.info.author || 'Unknown'}`.slice(0, 100),
                value: t.info.uri || `${preferred.split(':')[0]}:${t.info.title}`,
            }));
            return interaction.respond(choices);
        } catch {
            return interaction.respond([]);
        }
    },

    async execute(interaction, { shoukaku }) {
        await interaction.deferReply();

        const query = interaction.options.getString('query');
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            return interaction.editReply({ embeds: [{ color: 0xED4245, description: '❌ You need to be in a voice channel!' }] });
        }

        const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
        if (!perms.has('Connect') || !perms.has('Speak')) {
            return interaction.editReply({ embeds: [{ color: 0xED4245, description: '❌ I need **Connect** and **Speak** permissions in your voice channel!' }] });
        }

        const state = await createGuildPlayer({
            guildId: interaction.guildId,
            voiceChannelId: voiceChannel.id,
            shardId: interaction.guild.shardId,
            textChannel: interaction.channel,
            shoukaku,
        });

        // Resolve query
        let resolved;
        try {
            const node = shoukaku.getIdealNode();
            if (!node) throw new Error('No Lavalink node available. Is Lavalink running?');
            const isUrl = /^https?:\/\//i.test(query);
            const isSpotify = isUrl && /open\.spotify\.com/i.test(query);

            let searchQuery = query;
            if (isSpotify) {
                const spotifyTitle = await resolveSpotifyUrl(query);
                if (spotifyTitle) {
                    searchQuery = spotifyTitle; // e.g. "Bad Guy – Billie Eilish"
                } else {
                    return interaction.editReply({ embeds: [{ color: 0xFEE75C, description: '⚠️ Spotify-Link konnte nicht aufgelöst werden.' }] });
                }
            }

            if (isUrl && !isSpotify) {
                resolved = await node.rest.resolve(query);
            } else {
                // Quellen-Reihenfolge kommt aus dem playerManager: normalerweise
                // YouTube zuerst, nach mehreren Abspielfehlern SoundCloud zuerst.
                // Wichtig ist die zweite Quelle — ytsearch und ytmsearch sind
                // BEIDE YouTube und fallen deshalb immer gemeinsam aus.
                const identifiers = searchIdentifiers(searchQuery);
                for (const identifier of identifiers) {
                    try {
                        resolved = await node.rest.resolve(identifier);
                    } catch (resolveErr) {
                        console.warn(`[play] ${identifier.split(':')[0]} fehlgeschlagen: ${resolveErr.message}`);
                        resolved = null;
                        continue;
                    }
                    if (resolved && resolved.loadType !== 'empty' && resolved.loadType !== 'error') {
                        break;
                    }
                }
            }
        } catch (err) {
            console.error('[play] Resolve error:', err);
            return interaction.editReply({ embeds: [{ color: 0xED4245, description: `❌ Failed to fetch: \`${err.message}\`` }] });
        }

        if (!resolved || resolved.loadType === 'empty' || resolved.loadType === 'error') {
            return interaction.editReply({ embeds: [{ color: 0xFEE75C, description: '⚠️ No results found.' }] });
        }

        // Handle the queue update
        if (resolved.loadType === 'playlist') {
            const tracks = resolved.data.tracks;
            state.queue.push(...tracks);
            const totalDuration = tracks.reduce((acc, t) => acc + (t.info.length || 0), 0);
            
            // Send only a simple acknowledgment - let musicPanel show the status
            await interaction.editReply({ 
                content: `✅ **${resolved.data.info.name}** (${tracks.length} tracks, ${formatDuration(totalDuration)}) hinzugefügt!` 
            });
        } else {
            const track = resolved.loadType === 'search' ? resolved.data[0] : resolved.data;
            if (!track) {
                return interaction.editReply({ embeds: [{ color: 0xFEE75C, description: '⚠️ No results found.' }] });
            }

            state.queue.push(track);
            
            // Send only a simple acknowledgment - let musicPanel show the status
            if (state.current) {
                // Already playing, just confirm it was added to queue
                await interaction.editReply({ 
                    content: `✅ **${track.info.title}** zur Queue hinzugefügt!` 
                });
            } else {
                // Will start playing - let musicPanel show the status
                await interaction.editReply({ 
                    content: `✅ Starte: **${track.info.title}**` 
                });
            }
        }

        // Start playing if idle
        if (!state.current) {
            await playNext(interaction.guildId, { silent: true });
        }
    },
};

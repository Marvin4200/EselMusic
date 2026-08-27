/**
 * Music Channel Panel — one persistent embed that always shows
 * what's currently playing. Updated whenever the track changes.
 */
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { getGuildSettings, setGuildSettings } = require('./config');
const { formatDuration } = require('./formatDuration');

const LOGO_PATH = path.join(__dirname, '../../eselmusic.png');
const BANNER_PATH = path.join(__dirname, '../../eselmusicbanner.png');


function buildIdleEmbed() {
    const files = [];
    const embed = {
        color: 0x2B2D31,
        title: '🎵 EselMusic',
        description: '```\nNichts läuft gerade.\nSchreib einfach einen Songnamen hier rein!\n```',
        fields: [
            { name: 'Status', value: '⏹ Idle', inline: true },
            { name: 'Queue', value: '0 Tracks', inline: true },
        ],
    };

    if (fs.existsSync(LOGO_PATH)) {
        files.push(new AttachmentBuilder(LOGO_PATH, { name: 'eselmusic.png' }));
        embed.thumbnail = { url: 'attachment://eselmusic.png' };
        embed.footer = { text: 'EselMusic • Schreib einen Songnamen zum Spielen', icon_url: 'attachment://eselmusic.png' };
    }

    if (fs.existsSync(BANNER_PATH)) {
        files.push(new AttachmentBuilder(BANNER_PATH, { name: 'eselmusicbanner.png' }));
        embed.image = { url: 'attachment://eselmusicbanner.png' };
    }

    return {
        embeds: [embed],
        components: [],
        files,
    };
}

function buildQueueEmbed(queue) {
    const count = queue?.length || 0;

    if (count === 0) {
        return {
            color: 0x2B2D31,
            title: '📋 Queue',
            description: '*— Leer —*',
        };
    }

    const MAX = 15;
    const lines = (queue || []).slice(0, MAX).map((t, i) => {
        const title = String(t?.info?.title || 'Unknown').slice(0, 50);
        const author = String(t?.info?.author || '').slice(0, 28);
        return `\`${String(i + 1).padStart(2, ' ')}.\` **${title}**${author ? ` — ${author}` : ''}`;
    });
    if (count > MAX) lines.push(`*…+${count - MAX} weitere Tracks*`);

    return {
        color: 0x2B2D31,
        title: `📋 Queue — ${count} Track${count !== 1 ? 's' : ''}`,
        description: lines.join('\n'),
    };
}

function buildTrackEmbed(track, state) {
    const files = [];
    const len = track.info.length || 0;
    const pos = state.player?.position || 0;

    const BAR = 20;
    const filled = len > 0 ? Math.round((pos / len) * BAR) : 0;
    const bar = '▓'.repeat(filled) + '░'.repeat(BAR - filled);

    const thumbnail = track.info.artworkUrl
        || (track.info.identifier ? `https://img.youtube.com/vi/${track.info.identifier}/mqdefault.jpg` : null);

    const duration = track.info.isStream ? 'LIVE 🔴' : formatDuration(len);

    const embed = {
        color: 0x5865F2,
        title: '🎵 Jetzt läuft',
        description: `**[${track.info.title}](${track.info.uri})**\n\n${bar}`,
        fields: [
            { name: '👤 Artist', value: track.info.author || 'Unknown', inline: true },
            { name: '⏱ Dauer', value: duration, inline: true },
            { name: '🔁 Loop', value: state.loop || 'none', inline: true },
            { name: '🔊 Volume', value: `${state.volume}%`, inline: true },
            { name: '🌙 24/7', value: state.is247 ? '✅ An' : '❌ Aus', inline: true },
            // AutoMix-Tracks hat niemand angefragt - dann bleibt das Feld weg,
            // statt eine leere Zeile ins Embed zu setzen.
            ...(track.requestedBy
                ? [{ name: '🙋 Angefragt von', value: `<@${track.requestedBy}>`, inline: true }]
                : []),
        ],
        ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
    };

    if (fs.existsSync(LOGO_PATH)) {
        files.push(new AttachmentBuilder(LOGO_PATH, { name: 'eselmusic.png' }));
        embed.footer = { text: 'EselMusic • Schreib einen Songnamen zum Spielen', icon_url: 'attachment://eselmusic.png' };
        if (!thumbnail) embed.thumbnail = { url: 'attachment://eselmusic.png' };
    }

    if (fs.existsSync(BANNER_PATH)) {
        files.push(new AttachmentBuilder(BANNER_PATH, { name: 'eselmusicbanner.png' }));
        embed.image = { url: 'attachment://eselmusicbanner.png' };
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('panel:vol_down')
            .setEmoji('🔉')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('panel:skip')
            .setEmoji('⏭')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('panel:vol_up')
            .setEmoji('🔊')
            .setStyle(ButtonStyle.Secondary),
    );

    return {
        embeds: [embed, buildQueueEmbed(state.queue)],
        components: [row],
        files,
    };
}

/**
 * Send or update the persistent music panel in the configured music channel.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {object|null} state - PlayerState or null when idle
 */
async function doUpdateMusicPanel(client, guildId, state) {
    const settings = getGuildSettings(guildId);
    if (!settings.musicChannelId) return;

    let channel;
    try {
        channel = await client.channels.fetch(settings.musicChannelId);
    } catch {
        return;
    }
    if (!channel?.isTextBased()) return;

    const payload = (state && state.current)
        ? buildTrackEmbed(state.current, state)
        : buildIdleEmbed();

    // Try to edit the existing panel message
    let edited = false;
    if (settings.musicPanelMsgId) {
        try {
            const existing = await channel.messages.fetch(settings.musicPanelMsgId);
            await existing.edit(payload);
            edited = true;
            return;
        } catch (err) {
            const code = err?.code ?? err?.rawError?.code;
            if (code === 10008 /* Unknown Message */ || code === 50001 /* Missing Access */) {
                setGuildSettings(guildId, { musicPanelMsgId: null });
            } else {
                console.error('[MusicPanel] Edit failed:', err?.message);
                return;
            }
        }
    }

    // Only send a new message if we couldn't edit an existing one
    if (!edited) {
        try {
            const msg = await channel.send(payload);
            setGuildSettings(guildId, { musicPanelMsgId: msg.id });
        } catch (err) {
            console.error('[MusicPanel] Failed to send panel:', err?.message);
        }
    }
}

/**
 * Panel updates fire from several places in quick succession (track start,
 * recovery, 15s refresh tick). Each one is its own async fetch+edit, so
 * without serialization two overlapping updates can land at Discord out of
 * order — the slower one (built from an already-stale `state.current`)
 * would then overwrite the correct panel. This queues per guild: only one
 * update in flight at a time, and any updates requested meanwhile collapse
 * into a single trailing re-render that reads the (by then current) state.
 */
const inFlight = new Set();
const pendingRerun = new Map();

async function updateMusicPanel(client, guildId, state) {
    if (inFlight.has(guildId)) {
        pendingRerun.set(guildId, { client, guildId, state });
        return;
    }
    inFlight.add(guildId);
    try {
        await doUpdateMusicPanel(client, guildId, state);
    } finally {
        inFlight.delete(guildId);
        const pending = pendingRerun.get(guildId);
        if (pending) {
            pendingRerun.delete(guildId);
            updateMusicPanel(pending.client, pending.guildId, pending.state).catch(() => {});
        }
    }
}

module.exports = { updateMusicPanel };

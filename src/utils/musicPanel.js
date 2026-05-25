/**
 * Music Channel Panel — one persistent embed that always shows
 * what's currently playing. Updated whenever the track changes.
 */
const { AttachmentBuilder } = require('discord.js');
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

    return {
        embeds: [embed, buildQueueEmbed(state.queue)],
        components: [],
        files,
    };
}

/**
 * Send or update the persistent music panel in the configured music channel.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {object|null} state - PlayerState or null when idle
 */
async function updateMusicPanel(client, guildId, state) {
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

    // Try to edit the existing panel message.
    if (settings.musicPanelMsgId) {
        try {
            const existing = await channel.messages.fetch(settings.musicPanelMsgId);
            await existing.edit(payload);
            return;
        } catch (err) {
            // Message deleted or inaccessible — clear stored ID and send a fresh one.
            const code = err?.code ?? err?.rawError?.code;
            if (code === 10008 /* Unknown Message */ || code === 50001 /* Missing Access */) {
                setGuildSettings(guildId, { musicPanelMsgId: null });
            } else {
                // Transient error (rate-limit, network) — don't resend, just skip this cycle.
                return;
            }
        }
    }

    // Send a new panel message and remember its ID.
    try {
        const msg = await channel.send(payload);
        setGuildSettings(guildId, { musicPanelMsgId: msg.id });
    } catch (err) {
        console.error('[MusicPanel] Failed to send panel:', err?.message);
    }
}

module.exports = { updateMusicPanel };

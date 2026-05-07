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

function buildPanelControlsRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music:pause').setLabel('⏸ Pause').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('music:skip').setLabel('⏭ Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:shuffle').setLabel('🔀 Shuffle').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music:stop').setLabel('⏹ Stop').setStyle(ButtonStyle.Danger),
    );
}

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
        components: [buildPanelControlsRow()],
        files,
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
            { name: '📋 Queue', value: `${state.queue?.length || 0} Track(s)`, inline: true },
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
        embeds: [embed],
        components: [buildPanelControlsRow()],
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
        } catch {
            // Message gone — fall through and send a fresh one.
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

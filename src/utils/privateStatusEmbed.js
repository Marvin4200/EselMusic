const fs = require('fs');
const path = require('path');
const { PermissionsBitField } = require('discord.js');
const { getAllIs247Guilds } = require('./config');

const UPDATE_INTERVAL_MS = 60_000;
const STORAGE_PATH = path.join(__dirname, '../../data/private-status-message.json');

function resolveTargetIds() {
    const guildId =
        process.env.MUSIKBOT_PRIVATE_STATUS_GUILD_ID
        || process.env.PRIVATE_STATUS_GUILD_ID
        || process.env.DEV_LOG_GUILD_ID
        || process.env.LOG_GUILD_ID
        || null;

    const channelId =
        process.env.MUSIKBOT_PRIVATE_STATUS_CHANNEL_ID
        || process.env.PRIVATE_STATUS_CHANNEL_ID
        || process.env.DEV_LOG_CHANNEL_ID
        || process.env.LOG_CHANNEL_ID
        || null;

    return { guildId, channelId };
}

function readStoredMessageMeta() {
    try {
        if (!fs.existsSync(STORAGE_PATH)) return null;
        const raw = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
        if (!raw || typeof raw !== 'object') return null;
        return {
            guildId: raw.guildId ? String(raw.guildId) : null,
            channelId: raw.channelId ? String(raw.channelId) : null,
            messageId: raw.messageId ? String(raw.messageId) : null,
            updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
        };
    } catch {
        return null;
    }
}

function writeStoredMessageMeta(meta) {
    try {
        fs.mkdirSync(path.dirname(STORAGE_PATH), { recursive: true });
        fs.writeFileSync(STORAGE_PATH, JSON.stringify({
            guildId: meta.guildId || null,
            channelId: meta.channelId || null,
            messageId: meta.messageId || null,
            updatedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
    } catch (err) {
        console.warn(`[PrivateStatus] Could not persist message metadata: ${err?.message || err}`);
    }
}

function formatUptime(secondsInput) {
    const seconds = Math.max(0, Math.floor(Number(secondsInput) || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (days > 0 || hours > 0) parts.push(`${hours}h`);
    if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
}

function isLavalinkConnected(shoukaku) {
    try {
        const main = shoukaku?.nodes?.get?.('main');
        const node = main || shoukaku?.getIdealNode?.();
        if (!node) return false;
        const state = node.state;
        return state === 1 || state === 'connected' || state === 'CONNECTED';
    } catch {
        return false;
    }
}

function buildEmbed({ client, shoukaku, players }) {
    const lavalinkConnected = isLavalinkConnected(shoukaku);
    const botOnline = Boolean(client?.readyAt);
    const is247Sessions = getAllIs247Guilds().length;

    let activePlayers = 0;
    let totalQueue = 0;
    let sample = null;

    for (const [guildId, state] of players.entries()) {
        const queueLength = Array.isArray(state?.queue) ? state.queue.length : 0;
        totalQueue += queueLength;
        const hasCurrent = Boolean(state?.current);
        if (hasCurrent || queueLength > 0) activePlayers += 1;

        if (!sample && hasCurrent) {
            sample = { guildId, state };
        }
    }

    const nowUnix = Math.floor(Date.now() / 1000);

    const fields = [
        { name: 'Bot', value: botOnline ? 'Online' : 'Offline', inline: true },
        { name: 'Lavalink', value: lavalinkConnected ? 'Verbunden' : 'Getrennt', inline: true },
        { name: 'Aktive Player', value: String(activePlayers), inline: true },
        { name: 'Aktive Guilds mit Player', value: String(players.size), inline: true },
        { name: '24/7 Sessions', value: String(is247Sessions), inline: true },
        { name: 'Queue gesamt', value: String(totalQueue), inline: true },
        { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
        { name: 'Letztes Update', value: `<t:${nowUnix}:F>`, inline: true },
    ];

    if (sample?.state?.current) {
        const guild = client.guilds.cache.get(sample.guildId);
        const voiceChannelId = sample.state?.player?.connection?.channelId;
        const voiceChannel = voiceChannelId
            ? guild?.channels?.cache?.get?.(voiceChannelId)
            : null;

        fields.push({ name: 'Guild', value: guild?.name || sample.guildId, inline: false });
        fields.push({ name: 'Voice Channel', value: voiceChannel?.name || '—', inline: true });
        fields.push({ name: 'Tracktitel', value: sample.state.current?.info?.title || '—', inline: false });
        fields.push({
            name: 'Queue-Länge',
            value: String(Array.isArray(sample.state.queue) ? sample.state.queue.length : 0),
            inline: true,
        });
    }

    let color = 0xED4245;
    if (botOnline && lavalinkConnected) {
        color = activePlayers > 0 ? 0x57F287 : 0xFEE75C;
    }

    return {
        embeds: [{
            title: '🎵 EselMusic Status',
            color,
            fields,
            timestamp: new Date().toISOString(),
        }],
    };
}

function createPrivateStatusEmbedManager({ client, shoukaku, players }) {
    let interval = null;
    let running = false;
    let activeMessageId = null;
    let cachedGuildId = null;
    let cachedChannelId = null;

    async function resolveTargetChannel() {
        const { guildId, channelId } = resolveTargetIds();
        cachedGuildId = guildId;
        cachedChannelId = channelId;

        if (!guildId || !channelId) {
            console.warn('[PrivateStatus] Missing fixed guild/channel id configuration; status embed disabled.');
            return null;
        }

        let guild;
        try {
            guild = await client.guilds.fetch(guildId);
        } catch (err) {
            console.warn(`[PrivateStatus] Cannot access fixed guild ${guildId}: ${err?.message || err}`);
            return null;
        }

        let channel;
        try {
            channel = await guild.channels.fetch(channelId);
        } catch (err) {
            console.warn(`[PrivateStatus] Cannot access fixed channel ${channelId}: ${err?.message || err}`);
            return null;
        }

        if (!channel?.isTextBased?.()) {
            console.warn(`[PrivateStatus] Fixed channel ${channelId} is not text-based.`);
            return null;
        }

        const perms = channel.permissionsFor(client.user?.id);
        if (!perms?.has(PermissionsBitField.Flags.ViewChannel) || !perms?.has(PermissionsBitField.Flags.SendMessages)) {
            console.warn(`[PrivateStatus] Missing access to fixed channel ${channelId}.`);
            return null;
        }

        return channel;
    }

    async function ensureMessage(channel) {
        const stored = readStoredMessageMeta();
        if (
            stored?.messageId
            && stored?.guildId === cachedGuildId
            && stored?.channelId === cachedChannelId
        ) {
            activeMessageId = stored.messageId;
        }

        if (activeMessageId) {
            try {
                const existing = await channel.messages.fetch(activeMessageId);
                if (existing) return existing;
            } catch (err) {
                const code = Number(err?.code);
                if (code !== 10008) {
                    console.warn(`[PrivateStatus] Could not fetch existing status message: ${err?.message || err}`);
                }
                activeMessageId = null;
            }
        }

        try {
            const created = await channel.send(buildEmbed({ client, shoukaku, players }));
            activeMessageId = created.id;
            writeStoredMessageMeta({ guildId: cachedGuildId, channelId: cachedChannelId, messageId: created.id });
            return created;
        } catch (err) {
            console.warn(`[PrivateStatus] Failed to create status message: ${err?.message || err}`);
            return null;
        }
    }

    async function updateOnce() {
        if (running) return;
        running = true;
        try {
            const channel = await resolveTargetChannel();
            if (!channel) return;

            const message = await ensureMessage(channel);
            if (!message) return;

            try {
                await message.edit(buildEmbed({ client, shoukaku, players }));
                writeStoredMessageMeta({ guildId: cachedGuildId, channelId: cachedChannelId, messageId: message.id });
            } catch (err) {
                const code = Number(err?.code);
                if (code === 10008) {
                    activeMessageId = null;
                    const recreated = await ensureMessage(channel);
                    if (recreated) {
                        await recreated.edit(buildEmbed({ client, shoukaku, players }));
                    }
                    return;
                }
                console.warn(`[PrivateStatus] Failed to edit status message: ${err?.message || err}`);
            }
        } catch (err) {
            console.warn(`[PrivateStatus] Unexpected update error: ${err?.message || err}`);
        } finally {
            running = false;
        }
    }

    function start() {
        if (interval) return;
        updateOnce().catch(() => { });
        interval = setInterval(() => {
            updateOnce().catch(() => { });
        }, UPDATE_INTERVAL_MS);
    }

    function stop() {
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
    }

    function requestUpdate() {
        updateOnce().catch(() => { });
    }

    return {
        start,
        stop,
        requestUpdate,
        UPDATE_INTERVAL_MS,
        STORAGE_PATH,
    };
}

module.exports = {
    createPrivateStatusEmbedManager,
    UPDATE_INTERVAL_MS,
    STORAGE_PATH,
};

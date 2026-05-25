require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const fs = require('fs');
const path = require('path');

const { players, destroyPlayer, setDiscordClient, setShoukaku, createGuildPlayer, playNext, scheduleRejoin } = require('./src/utils/playerManager');
const { getPlaybackControlError } = require('./src/utils/djCheck');
const { getGuildSettings, getAllIs247Guilds, setGuildSettings } = require('./src/utils/config');
const { updateMusicPanel } = require('./src/utils/musicPanel');
const { logEvent, safeErrorMessage, shouldIgnoreError } = require('./src/utils/musicLogger');
const { createPrivateStatusEmbedManager } = require('./src/utils/privateStatusEmbed');

// Cooldown for music-channel diagnostic warnings to avoid spam.
const musicChannelWarnCooldown = new Map();

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ─── Lavalink / Shoukaku ─────────────────────────────────────────────────────
// Validate Lavalink password is not default in production
if (process.env.NODE_ENV === 'production' &&
    (!process.env.LAVALINK_PASSWORD || process.env.LAVALINK_PASSWORD === 'youshallnotpass')) {
    throw new Error('LAVALINK_PASSWORD must be set and must not be the default "youshallnotpass" in production. Refusing to start.');
} else if (!process.env.LAVALINK_PASSWORD || process.env.LAVALINK_PASSWORD === 'youshallnotpass') {
    console.warn('[WARN] Using default Lavalink password — change LAVALINK_PASSWORD before deploying to production!');
}

const lavalinkNodes = [{
    name: 'main',
    url: process.env.LAVALINK_HOST || 'localhost:2333',
    auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
}];

const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), lavalinkNodes, {
    reconnectTries: 5,
    reconnectInterval: 5000,
    resume: true,
});

const privateStatus = createPrivateStatusEmbedManager({
    client,
    shoukaku,
    players,
});

shoukaku.on('error', (node, error) => {
    console.error(`[Shoukaku] Node "${node}" error:`, error.message);
    privateStatus.requestUpdate();
});
shoukaku.on('debug', (name, info) => {
    console.log(`[Shoukaku:${name}] ${info}`);
});
shoukaku.on('ready', (name) => {
    console.log(`✅ Lavalink node "${name}" connected`);
    privateStatus.requestUpdate();
    // Log to every guild that has a log channel configured
    for (const [guildId] of client.guilds.cache) {
        logEvent(client, guildId, 'lavalink_connected', {
            description: `Lavalink Node "${name}" ist verbunden.`,
        }).catch(() => { });
    }
});
shoukaku.on('close', (name, code, reason) => {
    console.warn(`⚠️ Lavalink node "${name}" closed: ${code} ${reason}`);
    privateStatus.requestUpdate();
    for (const [guildId] of client.guilds.cache) {
        logEvent(client, guildId, 'lavalink_disconnected', {
            description: `Lavalink Node "${name}" getrennt (Code ${code}).`,
            reason: reason ? String(reason).slice(0, 100) : undefined,
        }).catch(() => { });
    }
});
shoukaku.on('disconnect', (name, moved) => {
    if (moved) return;
    console.warn(`⚠️ Lavalink node "${name}" disconnected`);
    privateStatus.requestUpdate();
    for (const [guildId] of client.guilds.cache) {
        logEvent(client, guildId, 'lavalink_disconnected', {
            description: `Lavalink Node "${name}" verbindung verloren.`,
        }).catch(() => { });
    }
});

// ─── Load Commands ────────────────────────────────────────────────────────────
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'src', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
const ALLOWED_COMMANDS = new Set(['247', 'musicchannel', 'logchannel']);
const commandData = [];

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));

    if (!command?.data?.name || !ALLOWED_COMMANDS.has(command.data.name)) {
        console.log(`[Commands] Skipping disabled command file: ${file}`);
        continue;
    }

    client.commands.set(command.data.name, command);
    commandData.push(command.data.toJSON());
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.username}`);
    setDiscordClient(client);
    setShoukaku(shoukaku);
    privateStatus.start();

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    // Register per-guild for instant availability (no 1-hour propagation delay).
    const guilds = client.guilds.cache.map(g => g.id);
    let registered = 0;
    for (const guildId of guilds) {
        try {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commandData });
            registered++;
        } catch (err) {
            console.error(`❌ Failed to register commands in guild ${guildId}:`, err.message);
        }
    }
    console.log(`✅ Registered ${commandData.length} slash command(s) in ${registered}/${guilds.length} guild(s)`);

    // Log bot_start to every guild that has a log channel
    for (const guildId of guilds) {
        logEvent(client, guildId, 'bot_start', {
            description: `${client.user.username} ist gestartet und bereit.`,
        }).catch(() => { });
    }

    // ── 24/7 Auto-Rejoin after restart ────────────────────────────────────────
    // Wait for Lavalink node to be fully ready before rejoining.
    // On failure, fall back to scheduleRejoin which retries with exponential backoff.
    setTimeout(async () => {
        const is247Guilds = getAllIs247Guilds();
        for (const row of is247Guilds) {
            try {
                const guild = client.guilds.cache.get(row.guild_id);
                if (!guild) continue;
                const voiceChannel = guild.channels.cache.get(row.voice_channel_id);
                if (!voiceChannel) continue;
                // Find a text channel to use (music channel if configured, else system channel)
                const textChannel = row.music_channel_id
                    ? guild.channels.cache.get(row.music_channel_id)
                    : guild.systemChannel;
                await createGuildPlayer({
                    guildId: row.guild_id,
                    voiceChannelId: row.voice_channel_id,
                    shardId: guild.shardId,
                    textChannel: textChannel || null,
                    shoukaku,
                });
                await playNext(row.guild_id, { silent: true });
                textChannel?.send({ embeds: [{ color: 0x5865F2, description: '🔁 **24/7 Modus** — Bot ist dem Channel nach Neustart wieder beigetreten.' }] })
                    .then(m => setTimeout(() => m.delete().catch(() => {}), 10_000))
                    .catch(() => { });
                console.log(`[247] Rejoined voice channel ${row.voice_channel_id} in guild ${row.guild_id}`);
            } catch (err) {
                console.warn(`[247] Initial rejoin failed for guild ${row.guild_id}: ${err.message} — scheduling retry with backoff`);
                scheduleRejoin(row.guild_id);
            }
        }
    }, 15_000);

    privateStatus.requestUpdate();
});

client.on('interactionCreate', async (interaction) => {
    // ── Autocomplete ──────────────────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (command?.autocomplete) {
            try {
                await command.autocomplete(interaction, { shoukaku, client });
            } catch {
                interaction.respond([]).catch(() => { });
            }
        }
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('music:')) {
        return interaction.reply({
            embeds: [{
                color: 0xFEE75C,
                description: '⚠️ EselMusic läuft jetzt im 24/7 Music-Channel-Modus. Schreibe einfach einen Songnamen oder Link in den Musik-Channel.'
            }],
            flags: [64],
        }).catch(() => {});
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction, { shoukaku, client });
    } catch (err) {
        const code = Number(err?.code);
        const isIgnoredInteractionError = code === 10062 || code === 40060;
        if (isIgnoredInteractionError) {
            console.warn(`[Interaction] Ignored expired/already acknowledged interaction for /${interaction.commandName}`);
            return;
        }

        console.error(`[Command Error] /${interaction.commandName}:`, err);

        // Log to guild's Discord log channel (no stack, no secrets)
        if (interaction.guildId) {
            logEvent(client, interaction.guildId, 'command_error', {
                userId: interaction.user?.id,
                channelId: interaction.channelId,
                reason: `/${interaction.commandName}: ${safeErrorMessage(err)}`,
                errorCode: err?.code ? String(err.code) : undefined,
            }).catch(() => { });
        }

        const errPayload = {
            embeds: [{ color: 0xED4245, description: `❌ An error occurred: ${err.message || 'Unknown error'}` }],
            flags: [64],
        };
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errPayload).catch((replyErr) => {
                const replyCode = Number(replyErr?.code);
                if (replyCode === 10062 || replyCode === 40060) {
                    console.warn(`[Interaction] Ignored expired/already acknowledged interaction for /${interaction.commandName}`);
                }
            });
        } else {
            await interaction.reply(errPayload).catch((replyErr) => {
                const replyCode = Number(replyErr?.code);
                if (replyCode === 10062 || replyCode === 40060) {
                    console.warn(`[Interaction] Ignored expired/already acknowledged interaction for /${interaction.commandName}`);
                }
            });
        }
    }
});

// ─── Music Channel: treat plain text messages as play requests ──────────────
client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!message.guild) return;

        const settings = getGuildSettings(message.guildId);
        if (!settings.musicChannelId || message.channelId !== settings.musicChannelId) return;

        // Delete the user's message to keep the channel clean.
        message.delete().catch(() => { });

        const query = (message.content || '').trim();
        if (!query) {
            const now = Date.now();
            const nextAllowed = musicChannelWarnCooldown.get(message.guildId) || 0;
            if (now >= nextAllowed) {
                musicChannelWarnCooldown.set(message.guildId, now + 60_000);
                const warn = await message.channel.send({
                    embeds: [{
                        color: 0xFEE75C,
                        description: '⚠️ Ich kann den Nachrichtentext nicht lesen. Bitte pruefe, ob **Message Content Intent** fuer den Bot aktiv ist, oder nutze vorerst Slash-Commands wie `/play`.',
                    }],
                }).catch(() => null);
                if (warn) setTimeout(() => warn.delete().catch(() => { }), 8000);
            }
            return;
        }

        // Re-use the play command logic inline.
        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) {
            const warn = await message.channel.send({ embeds: [{ color: 0xED4245, description: `❌ ${message.author}, du musst in einem Voice-Channel sein!` }] });
            setTimeout(() => warn.delete().catch(() => { }), 5000);
            return;
        }

        const { createGuildPlayer, playNext } = require('./src/utils/playerManager');
        const { formatDuration } = require('./src/utils/formatDuration');

        let state;
        try {
            state = await createGuildPlayer({
                guildId: message.guildId,
                voiceChannelId: voiceChannel.id,
                shardId: message.guild.shardId ?? 0,
                textChannel: message.channel,
                shoukaku,
            });
        } catch (err) {
            const warn = await message.channel.send({ embeds: [{ color: 0xED4245, description: `❌ Konnte nicht connecten: ${err.message}` }] });
            setTimeout(() => warn.delete().catch(() => { }), 6000);
            return;
        }

        const node = shoukaku.getIdealNode();
        if (!node) {
            const warn = await message.channel.send({ embeds: [{ color: 0xED4245, description: '❌ Kein Lavalink-Node verfügbar.' }] });
            setTimeout(() => warn.delete().catch(() => { }), 5000);
            return;
        }

        let resolved;
        try {
            const identifiers = [`ytsearch:${query}`, `ytmsearch:${query}`];
            for (const id of identifiers) {
                resolved = await node.rest.resolve(id);
                if (resolved && resolved.loadType !== 'empty' && resolved.loadType !== 'error') break;
            }
        } catch (err) {
            const warn = await message.channel.send({ embeds: [{ color: 0xED4245, description: `❌ Suche fehlgeschlagen: ${err.message}` }] });
            setTimeout(() => warn.delete().catch(() => { }), 6000);
            return;
        }

        const track = resolved?.loadType === 'search' ? resolved.data?.[0] : null;
        if (!track) {
            const warn = await message.channel.send({ embeds: [{ color: 0xFEE75C, description: `⚠️ Keine Ergebnisse für: **${query}**` }] });
            setTimeout(() => warn.delete().catch(() => { }), 5000);
            return;
        }

        state.queue.push(track);

        const position = state.current ? state.queue.length : 1;
        const durLabel = track.info.isStream ? 'LIVE 🔴' : formatDuration(track.info.length);
        const addedMsg = await message.channel.send({
            embeds: [{
                color: 0x5865F2,
                description: state.current
                    ? `➕ **${track.info.title}** zur Queue hinzugefügt (Position #${position})`
                    : `▶️ **${track.info.title}** wird jetzt gespielt`,
                footer: { text: `${track.info.author || 'Unknown'} • ${durLabel} • von ${message.author.username}` },
            }],
        });
        setTimeout(() => addedMsg.delete().catch(() => { }), 8000);

        if (!state.current) {
            await playNext(message.guildId, { silent: true });
            await updateMusicPanel(client, message.guildId, state);
        } else {
            await updateMusicPanel(client, message.guildId, state);
        }
    } catch (err) {
        console.error('[MUSIC_CHANNEL_001] messageCreate handler error:', err);
    }
});

// ─── Auto-leave when bot is alone in voice channel ───────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
    const botId = client.user?.id;
    if (!botId) return;

    // ── Bot itself was disconnected/kicked ────────────────────────────────────
    if (oldState.id === botId && oldState.channelId && !newState.channelId) {
        const settings = getGuildSettings(oldState.guild.id);
        if (!settings.is247) {
            // Not 24/7 — clean up player state
            players.delete(oldState.guild.id);
        }
        // For 24/7 guilds: player.on('closed') in playerManager fires when Shoukaku
        // detects the voice drop and calls scheduleRejoin() with exponential backoff
        // and a max-retry cap. No additional rejoin logic needed here.
        return;
    }

    // ── All humans left the voice channel ─────────────────────────────────────
    if (!oldState.channelId) return;
    const channel = oldState.channel;
    if (!channel) return;
    if (!channel.members.has(botId)) return;
    const humanMembers = channel.members.filter(m => !m.user.bot);
    if (humanMembers.size > 0) return;

    const state = players.get(oldState.guild.id);
    if (!state || state.is247) return;

    destroyPlayer(oldState.guild.id, shoukaku);
    state.textChannel?.send({ embeds: [{ color: 0x5865F2, description: '👋 Left voice channel (everyone left).' }] })
        .then(m => setTimeout(() => m.delete().catch(() => {}), 10_000))
        .catch(() => { });
});

// ─── Login ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── API Auth middleware ───────────────────────────────────────────────────────
// If MUSIKBOT_API_TOKEN is set in env, all /api/* routes require a matching Bearer token.
// If not set, /api/* is restricted to loopback/container-internal callers only.
function apiAuth(req, res, next) {
    const expectedToken = process.env.MUSIKBOT_API_TOKEN || '';
    if (expectedToken) {
        const authHeader = req.headers['authorization'] || '';
        const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!provided || provided !== expectedToken) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    } else {
        // No token configured — only allow loopback
        const ip = req.socket?.remoteAddress || '';
        if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
            return res.status(403).json({ success: false, error: 'Forbidden: set MUSIKBOT_API_TOKEN to enable external access' });
        }
    }
    next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'musikbot', uptime: process.uptime() }));

// ── GET /api/status ───────────────────────────────────────────────────────────
app.get('/api/status', apiAuth, (req, res) => {
    const lavalinkNode = shoukaku.nodes?.get('main');
    const lavalinkConnected = lavalinkNode?.state === 1 /* Connected */ || lavalinkNode?.state === 'connected';

    res.json({
        success: true,
        data: {
            online: true,
            uptime: process.uptime(),
            guildCount: client.guilds.cache.size,
            lavalinkConnected: Boolean(lavalinkConnected),
            activePlayers: players.size,
        },
    });
});

// ── GET /api/guilds ───────────────────────────────────────────────────────────
app.get('/api/guilds', apiAuth, (req, res) => {
    const result = [];
    for (const [guildId, guild] of client.guilds.cache) {
        const state = players.get(guildId);
        const settings = getGuildSettings(guildId);
        result.push({
            guildId,
            guildName: guild.name,
            is247: settings.is247,
            hasPlayer: Boolean(state),
            nowPlaying: state?.current?.info?.title || null,
            queueLength: state?.queue?.length ?? 0,
        });
    }
    res.json({ success: true, data: result });
});

// ── GET /api/guild/:id ────────────────────────────────────────────────────────
app.get('/api/guild/:id', apiAuth, (req, res) => {
    const guildId = req.params.id;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).json({ success: false, error: 'Guild not found' });
    }
    const state = players.get(guildId);
    const settings = getGuildSettings(guildId);

    const nowPlaying = state?.current ? {
        title: state.current.info?.title || null,
        author: state.current.info?.author || null,
        duration: state.current.info?.length || null,
        isStream: state.current.info?.isStream || false,
        uri: state.current.info?.uri || null,
    } : null;

    res.json({
        success: true,
        data: {
            guildId,
            guildName: guild.name,
            is247: settings.is247,
            voiceChannelId: settings.voiceChannelId,
            musicChannelId: settings.musicChannelId,
            logChannelId: settings.logChannelId,
            volume: settings.volume,
            hasPlayer: Boolean(state),
            loop: state?.loop || 'none',
            paused: state?.player?.paused || false,
            nowPlaying,
            queueLength: state?.queue?.length ?? 0,
        },
    });
});

// ── GET /api/guild/:id/settings ───────────────────────────────────────────────
app.get('/api/guild/:id/settings', apiAuth, (req, res) => {
    const guildId = req.params.id;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).json({ success: false, error: 'Guild not found' });
    }
    const settings = getGuildSettings(guildId);
    res.json({
        success: true,
        data: {
            guildId,
            djRoleId: settings.djRoleId,
            is247: settings.is247,
            volume: settings.volume,
            musicChannelId: settings.musicChannelId,
            voiceChannelId: settings.voiceChannelId,
            logChannelId: settings.logChannelId,
        },
    });
});

// ── POST /api/guild/:id/settings ──────────────────────────────────────────────
// Accepts: { is247, volume, logChannelId, musicChannelId, djRoleId }
// Applies valid fields to guild_settings. Player in-memory state updated where applicable.
app.post('/api/guild/:id/settings', apiAuth, (req, res) => {
    const guildId = req.params.id;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).json({ success: false, error: 'Guild not found' });
    }

    const body = req.body || {};
    const update = {};

    if (typeof body.is247 === 'boolean') {
        update.is247 = body.is247;
        const state = players.get(guildId);
        if (state) state.is247 = body.is247;
    }
    if (typeof body.volume === 'number' && body.volume >= 0 && body.volume <= 150) {
        update.volume = Math.round(body.volume);
    }
    if (body.logChannelId === null || typeof body.logChannelId === 'string') {
        update.logChannelId = body.logChannelId || null;
    }
    if (body.musicChannelId === null || typeof body.musicChannelId === 'string') {
        update.musicChannelId = body.musicChannelId || null;
    }
    if (body.djRoleId === null || typeof body.djRoleId === 'string') {
        update.djRoleId = body.djRoleId || null;
    }

    if (Object.keys(update).length === 0) {
        return res.status(400).json({ success: false, error: 'No valid fields provided' });
    }

    setGuildSettings(guildId, update);
    const updated = getGuildSettings(guildId);

    res.json({
        success: true,
        data: {
            guildId,
            djRoleId: updated.djRoleId,
            is247: updated.is247,
            volume: updated.volume,
            musicChannelId: updated.musicChannelId,
            voiceChannelId: updated.voiceChannelId,
            logChannelId: updated.logChannelId,
        },
    });
});

app.listen(3020, () => console.log('[musikbot] Health + API endpoint running on port 3020'));

client.login(process.env.DISCORD_TOKEN);

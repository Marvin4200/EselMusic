require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const fs = require('fs');
const path = require('path');

const { players, destroyPlayer, setDiscordClient, setShoukaku, createGuildPlayer, playNext, scheduleRejoin } = require('./src/utils/playerManager');
const { getPlaybackControlError } = require('./src/utils/djCheck');
const { getGuildSettings, getAllIs247Guilds } = require('./src/utils/config');
const { updateMusicPanel } = require('./src/utils/musicPanel');

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

shoukaku.on('error', (node, error) => {
    console.error(`[Shoukaku] Node "${node}" error:`, error.message);
});
shoukaku.on('debug', (name, info) => {
    console.log(`[Shoukaku:${name}] ${info}`);
});
shoukaku.on('ready', (name) => console.log(`✅ Lavalink node "${name}" connected`));
shoukaku.on('close', (name, code, reason) => {
    console.warn(`⚠️ Lavalink node "${name}" closed: ${code} ${reason}`);
});
shoukaku.on('disconnect', (name, moved) => {
    if (moved) return;
    console.warn(`⚠️ Lavalink node "${name}" disconnected`);
});

// ─── Load Commands ────────────────────────────────────────────────────────────
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'src', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
const commandData = [];

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    client.commands.set(command.data.name, command);
    commandData.push(command.data.toJSON());
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
    console.log(`✅ Logged in as ${client.user.username}`);
    setDiscordClient(client);
    setShoukaku(shoukaku);

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
        const state = players.get(interaction.guildId);
        if (!state) {
            return interaction.reply({ embeds: [{ color: 0xFEE75C, description: '⚠️ Nothing is playing!' }], flags: [64] });
        }

        const accessError = getPlaybackControlError(interaction, { requireDj: true });
        if (accessError) {
            return interaction.reply({ embeds: [{ color: 0xED4245, description: accessError }], flags: [64] });
        }

        try {
            switch (interaction.customId) {
                case 'music:pause': {
                    const paused = state.player.paused;
                    await state.player.setPaused(!paused);
                    return interaction.reply({
                        embeds: [{ color: 0x5865F2, description: paused ? '▶️ Resumed!' : '⏸️ Paused!' }],
                        flags: [64],
                    });
                }
                case 'music:skip': {
                    const skipped = state.current?.info?.title || 'current track';
                    if (state.loop === 'track') state.loop = 'off';
                    await state.player.stopTrack();
                    return interaction.reply({ embeds: [{ color: 0x5865F2, description: `⏭️ Skipped **${skipped}**` }], flags: [64] });
                }
                case 'music:shuffle': {
                    if (state.queue.length < 2) {
                        return interaction.reply({
                            embeds: [{ color: 0xFEE75C, description: '⚠️ Need at least 2 tracks in the queue to shuffle!' }],
                            flags: [64],
                        });
                    }

                    for (let i = state.queue.length - 1; i > 0; i -= 1) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
                    }

                    return interaction.reply({ embeds: [{ color: 0x5865F2, description: `🔀 Shuffled **${state.queue.length}** tracks!` }], flags: [64] });
                }
                case 'music:stop': {
                    state.queue = [];
                    state.current = null;
                    state.loop = 'none';
                    destroyPlayer(interaction.guildId, shoukaku);
                    return interaction.reply({ embeds: [{ color: 0x5865F2, description: '⏹️ Stopped and cleared the queue.' }], flags: [64] });
                }
                default:
                    return interaction.reply({ embeds: [{ color: 0xFEE75C, description: '⚠️ Unknown control action.' }], flags: [64] });
            }
        } catch (err) {
            console.error(`[Button Error] ${interaction.customId}:`, err);
            return interaction.reply({ embeds: [{ color: 0xED4245, description: `❌ Control failed: ${err.message || 'Unknown error'}` }], flags: [64] });
        }
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction, { shoukaku, client });
    } catch (err) {
        console.error(`[Command Error] /${interaction.commandName}:`, err);
        const errPayload = {
            embeds: [{ color: 0xED4245, description: `❌ An error occurred: ${err.message || 'Unknown error'}` }],
            flags: [64],
        };
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(errPayload).catch(() => { });
        } else {
            await interaction.reply(errPayload).catch(() => { });
        }
    }
});

// ─── Music Channel: treat plain text messages as play requests ──────────────
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const settings = getGuildSettings(message.guildId);
    if (!settings.musicChannelId || message.channelId !== settings.musicChannelId) return;

    // Delete the user's message to keep the channel clean.
    message.delete().catch(() => { });

    const query = message.content.trim();
    if (!query) return;

    // Re-use the play command logic inline.
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
        const warn = await message.channel.send({ embeds: [{ color: 0xED4245, description: `❌ ${message.author}, du musst in einem Voice-Channel sein!` }] });
        setTimeout(() => warn.delete().catch(() => { }), 5000);
        return;
    }

    const { createGuildPlayer, playNext, players: playerMap } = require('./src/utils/playerManager');
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
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'musikbot', uptime: process.uptime() }));
app.listen(3020, () => console.log('[musikbot] Health endpoint running on port 3020'));

client.login(process.env.DISCORD_TOKEN);

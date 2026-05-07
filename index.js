require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const fs = require('fs');
const path = require('path');

const { players, destroyPlayer, setDiscordClient } = require('./src/utils/playerManager');
const { getPlaybackControlError } = require('./src/utils/djCheck');
const { getGuildSettings } = require('./src/utils/config');
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

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandData });
        console.log(`✅ Registered ${commandData.length} slash command(s) globally`);
    } catch (err) {
        console.error('❌ Failed to register slash commands:', err);
    }
});

client.on('interactionCreate', async (interaction) => {
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
client.on('voiceStateUpdate', (oldState) => {
    if (!oldState.channelId) return;
    const botId = client.user?.id;
    if (!botId) return;

    const channel = oldState.channel;
    if (!channel) return;

    if (!channel.members.has(botId)) return;

    const humanMembers = channel.members.filter(m => !m.user.bot);
    if (humanMembers.size > 0) return;

    const state = players.get(oldState.guild.id);
    if (!state || state.is247) return;

    destroyPlayer(oldState.guild.id, shoukaku);
    state.textChannel?.send({ embeds: [{ color: 0x5865F2, description: '👋 Left voice channel (everyone left).' }] }).catch(() => { });
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);

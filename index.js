require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');
const fs = require('fs');
const path = require('path');

const { players, destroyPlayer } = require('./src/utils/playerManager');

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
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

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandData });
        console.log(`✅ Registered ${commandData.length} slash command(s) globally`);
    } catch (err) {
        console.error('❌ Failed to register slash commands:', err);
    }
});

client.on('interactionCreate', async (interaction) => {
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

// Auto-leave when bot is alone in voice channel
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

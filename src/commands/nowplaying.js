const { SlashCommandBuilder } = require('discord.js');
const { players } = require('../utils/playerManager');
const { formatDuration } = require('../utils/formatDuration');
const { buildBrandPayload } = require('../utils/brandAssets');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show info about the currently playing song'),

    async execute(interaction) {
        const state = players.get(interaction.guildId);
        if (!state || !state.current) {
            return interaction.reply({ content: '⚠️ Nothing is playing!', flags: [64] });
        }

        const t = state.current;
        const pos = state.player.position || 0;
        const len = t.info.length || 0;

        // Progress bar
        const BAR_LENGTH = 20;
        const filled = len > 0 ? Math.round((pos / len) * BAR_LENGTH) : 0;
        const bar = '▓'.repeat(filled) + '░'.repeat(BAR_LENGTH - filled);
        const posLabel = t.info.isStream ? 'LIVE 🔴' : `${formatDuration(pos)} / ${formatDuration(len)}`;

        return interaction.reply({ 
            content: `🎵 **${t.info.title}**\nArtist: ${t.info.author || 'Unknown'}\n\n${bar}\n${posLabel}\n\nQueue: ${state.queue.length} track(s) | Volume: ${state.volume}% | 24/7: ${state.is247 ? '✅' : '❌'}`,
            flags: [64] 
        });
    },
};

const { SlashCommandBuilder } = require('discord.js');
const { players } = require('../utils/playerManager');
const { hasDJPermission } = require('../utils/djCheck');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),

    async execute(interaction) {
        if (!hasDJPermission(interaction)) {
            return interaction.reply({ embeds: [{ color: 0xED4245, description: '❌ You need the DJ role to skip!' }], flags: [64] });
        }

        const state = players.get(interaction.guildId);
        if (!state || !state.current) {
            return interaction.reply({ embeds: [{ color: 0xFEE75C, description: '⚠️ Nothing is playing!' }], flags: [64] });
        }

        const skipped = state.current.info.title;
        const wasLooping = state.loop === 'track';
        if (wasLooping) state.loop = 'off'; // force past the current track
        await state.player.stopTrack(); // triggers 'end' → playNext
        return interaction.reply({ embeds: [{ color: 0x5865F2, description: `⏭️ Skipped **${skipped}**${wasLooping ? ' *(Track-Loop deaktiviert)*' : ''}` }] });
    },
};

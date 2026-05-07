const { SlashCommandBuilder } = require('discord.js');
const { players } = require('../utils/playerManager');
const { hasDJPermission } = require('../utils/djCheck');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Set the playback volume')
        .addIntegerOption(opt =>
            opt.setName('level')
                .setDescription('Volume level (0–150)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(150)
        ),

    async execute(interaction) {
        if (!hasDJPermission(interaction)) {
            return interaction.reply({ embeds: [{ color: 0xED4245, description: '❌ You need the DJ role!' }], flags: [64] });
        }

        const state = players.get(interaction.guildId);
        if (!state || !state.current) {
            return interaction.reply({ embeds: [{ color: 0xFEE75C, description: '⚠️ Nothing is playing!' }], flags: [64] });
        }

        const level = interaction.options.getInteger('level');
        if (typeof state.player.setGlobalVolume === 'function') {
            await state.player.setGlobalVolume(level);
        } else if (typeof state.player.setVolume === 'function') {
            await state.player.setVolume(level);
        } else if (typeof state.player.update === 'function') {
            await state.player.update({ volume: level });
        } else {
            throw new Error('Volume control is not supported by the current player implementation');
        }
        state.volume = level;

        const emoji = level === 0 ? '🔇' : level < 50 ? '🔈' : level < 100 ? '🔉' : '🔊';
        return interaction.reply({ embeds: [{ color: 0x5865F2, description: `${emoji} Volume set to **${level}%**` }] });
    },
};

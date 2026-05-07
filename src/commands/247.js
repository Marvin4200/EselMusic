const { SlashCommandBuilder } = require('discord.js');
const { players } = require('../utils/playerManager');
const { setGuildSettings } = require('../utils/config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('247')
        .setDescription('Toggle 24/7 mode — bot stays in the channel even when queue is empty'),

    async execute(interaction) {
        if (!interaction.memberPermissions?.has('Administrator')) {
            return interaction.reply({ embeds: [{ color: 0xED4245, description: '❌ Only admins can toggle 24/7 mode!' }], flags: [64] });
        }

        const state = players.get(interaction.guildId);
        if (!state) {
            return interaction.reply({ embeds: [{ color: 0xFEE75C, description: '⚠️ The bot is not in a voice channel. Use `/play` first!' }], flags: [64] });
        }

        state.is247 = !state.is247;
        setGuildSettings(interaction.guildId, { is247: state.is247 });
        const icon = state.is247 ? '🟢' : '🔴';

        return interaction.reply({
            embeds: [{ color: 0x5865F2, description: `${icon} 24/7 mode **${state.is247 ? 'enabled' : 'disabled'}**` }],
        });
    },
};

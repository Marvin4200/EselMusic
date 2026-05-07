const { SlashCommandBuilder } = require('discord.js');
const { players, createGuildPlayer, playNext } = require('../utils/playerManager');
const { getGuildSettings, setGuildSettings } = require('../utils/config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('247')
        .setDescription('Toggle 24/7 mode — bot stays in the channel even when queue is empty'),

    async execute(interaction, { shoukaku }) {
        if (!interaction.memberPermissions?.has('Administrator')) {
            return interaction.reply({ embeds: [{ color: 0xED4245, description: '❌ Only admins can toggle 24/7 mode!' }], flags: [64] });
        }

        const state = players.get(interaction.guildId);
        const settings = getGuildSettings(interaction.guildId);
        const current247 = state ? state.is247 : settings.is247;
        const new247 = !current247;

        // Update in-memory state if player exists
        if (state) state.is247 = new247;

        // Always persist to DB
        setGuildSettings(interaction.guildId, { is247: new247 });

        const icon = new247 ? '🟢' : '🔴';
        const statusText = new247 ? 'aktiviert' : 'deaktiviert';

        // If enabling 24/7 and bot is not in a channel but user is, auto-join
        if (new247 && !state) {
            const voiceChannel = interaction.member.voice.channel;
            if (voiceChannel) {
                try {
                    const created = await createGuildPlayer({
                        guildId: interaction.guildId,
                        voiceChannelId: voiceChannel.id,
                        shardId: interaction.guild.shardId,
                        textChannel: interaction.channel,
                        shoukaku,
                    });

                    // Kick off autoplay immediately in 24/7 mode.
                    if (!created.current && created.queue.length === 0) {
                        await playNext(interaction.guildId, { silent: true });
                    }

                    return interaction.reply({
                        embeds: [{ color: 0x5865F2, description: `${icon} 24/7 Modus **${statusText}** — Bot ist deinem Channel beigetreten und bleibt dort.` }],
                    });
                } catch { /* fall through to normal reply */ }
            }
        }

        // If bot is already connected and idle, trigger 24/7 autoplay now.
        if (new247 && state && !state.current && state.queue.length === 0) {
            await playNext(interaction.guildId, { silent: true });
        }

        const hint = new247 && !state
            ? '\n> Tipp: Nutze `/play` um den Bot in deinen Channel zu holen.'
            : '';

        return interaction.reply({
            embeds: [{ color: 0x5865F2, description: `${icon} 24/7 Modus **${statusText}**${hint}` }],
        });
    },
};

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { players, createGuildPlayer, playNext } = require('../utils/playerManager');
const { getGuildSettings, setGuildSettings } = require('../utils/config');
const { logEvent } = require('../utils/musicLogger');

const IGNORED_INTERACTION_CODES = new Set([10062, 40060]);

function isIgnoredInteractionError(error) {
    const code = Number(error?.code);
    return IGNORED_INTERACTION_CODES.has(code);
}

async function safeRespond(interaction, payload) {
    try {
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(payload);
        }
        return await interaction.reply(payload);
    } catch (error) {
        if (isIgnoredInteractionError(error)) {
            console.warn('[Interaction] Ignored expired/already acknowledged interaction for /247');
            return null;
        }
        throw error;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('247')
        .setDescription('Toggle 24/7 mode — bot stays in the channel even when queue is empty'),

    async execute(interaction, { shoukaku }) {
        if (!interaction.deferred && !interaction.replied) {
            try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (error) {
                if (isIgnoredInteractionError(error)) {
                    console.warn('[Interaction] Ignored expired/already acknowledged interaction for /247');
                    return;
                }
                throw error;
            }
        }

        if (!interaction.memberPermissions?.has('Administrator')) {
            return safeRespond(interaction, { embeds: [{ color: 0xED4245, description: '❌ Only admins can toggle 24/7 mode!' }], flags: [64] });
        }

        const state = players.get(interaction.guildId);
        const settings = getGuildSettings(interaction.guildId);
        const current247 = state ? state.is247 : settings.is247;
        const new247 = !current247;

        // Update in-memory state if player exists
        if (state) state.is247 = new247;

        // Always persist to DB
        setGuildSettings(interaction.guildId, { is247: new247 });

        // Log the toggle to the guild's configured log channel
        const logEventName = new247 ? 'twentyfourseven_enabled' : 'twentyfourseven_disabled';
        logEvent(interaction.client, interaction.guildId, logEventName, {
            userId: interaction.user.id,
            channelId: interaction.channelId,
        }).catch(() => { });

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

                    return safeRespond(interaction, {
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

        return safeRespond(interaction, {
            embeds: [{ color: 0x5865F2, description: `${icon} 24/7 Modus **${statusText}**${hint}` }],
        });
    },
};

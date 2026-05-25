const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { setGuildSettings, getGuildSettings } = require('../utils/config');

const IGNORED_INTERACTION_CODES = new Set([10062, 40060]);

function isIgnoredInteractionError(error) {
    return IGNORED_INTERACTION_CODES.has(Number(error?.code));
}

async function safeRespond(interaction, payload) {
    try {
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(payload);
        }
        return await interaction.reply(payload);
    } catch (error) {
        if (isIgnoredInteractionError(error)) {
            console.warn('[Interaction] Ignored expired/already acknowledged interaction for /logchannel');
            return null;
        }
        throw error;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('logchannel')
        .setDescription('Log-Channel für EselMusic setzen oder entfernen')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub
                .setName('set')
                .setDescription('Log-Channel für diesen Server setzen')
                .addChannelOption(opt =>
                    opt
                        .setName('channel')
                        .setDescription('Textkanal für EselMusic-Logs')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('clear')
                .setDescription('Log-Channel Einstellung entfernen (kein Logging mehr)')
        )
        .addSubcommand(sub =>
            sub
                .setName('status')
                .setDescription('Aktuell konfigurierten Log-Channel anzeigen')
        ),

    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            } catch (error) {
                if (isIgnoredInteractionError(error)) {
                    console.warn('[Interaction] Ignored expired/already acknowledged interaction for /logchannel');
                    return;
                }
                throw error;
            }
        }

        // Guard: ManageGuild already enforced via setDefaultMemberPermissions,
        // but double-check for API/bot-level calls that bypass permission defaults.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
            !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
            return safeRespond(interaction, {
                embeds: [{ color: 0xED4245, description: '❌ Du benötigst die Berechtigung **Server verwalten**.' }],
            });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            const channel = interaction.options.getChannel('channel', true);

            // Verify the bot can actually send messages there
            const botMember = interaction.guild?.members?.me;
            if (botMember && !channel.permissionsFor(botMember)?.has('SendMessages')) {
                return safeRespond(interaction, {
                    embeds: [{ color: 0xFEE75C, description: `⚠️ Ich habe keine Schreibrechte in <#${channel.id}>. Bitte Kanal-Berechtigungen prüfen.` }],
                });
            }

            setGuildSettings(interaction.guildId, { logChannelId: channel.id });

            return safeRespond(interaction, {
                embeds: [{
                    color: 0x57F287,
                    title: '✅ Log-Channel gesetzt',
                    description: `EselMusic-Logs werden ab jetzt in <#${channel.id}> gesendet.`,
                }],
            });
        }

        if (sub === 'clear') {
            setGuildSettings(interaction.guildId, { logChannelId: null });

            return safeRespond(interaction, {
                embeds: [{
                    color: 0x5865F2,
                    description: '🗑️ Log-Channel entfernt. EselMusic sendet keine Discord-Logs mehr.',
                }],
            });
        }

        if (sub === 'status') {
            const settings = getGuildSettings(interaction.guildId);
            const channelDisplay = settings.logChannelId
                ? `<#${settings.logChannelId}>`
                : '*Nicht konfiguriert*';

            return safeRespond(interaction, {
                embeds: [{
                    color: 0x5865F2,
                    title: '🎵 EselMusic — Log-Channel',
                    fields: [{ name: 'Aktueller Log-Channel', value: channelDisplay }],
                }],
            });
        }
    },
};

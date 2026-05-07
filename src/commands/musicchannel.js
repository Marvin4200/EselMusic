const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, setGuildSettings } = require('../utils/config');
const { updateMusicPanel } = require('../utils/musicPanel');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('musicchannel')
        .setDescription('Konfiguriere den dedizierten Musik-Kanal')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Setzt den Musik-Kanal — dort erscheint das Live-Panel und Texte werden als Suche gewertet')
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Text-Kanal auswählen')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Entfernt den Musik-Kanal')
        )
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('Zeigt den aktuellen Musik-Kanal an')
        ),

    async execute(interaction, { client }) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'set') {
            const channel = interaction.options.getChannel('channel');

            // Check bot permissions in target channel.
            const perms = channel.permissionsFor(interaction.guild.members.me);
            if (!perms.has('SendMessages') || !perms.has('ManageMessages') || !perms.has('AttachFiles')) {
                return interaction.reply({
                    embeds: [{ color: 0xED4245, description: `❌ Ich brauche **Nachrichten senden**, **Nachrichten verwalten** und **Dateien anhängen** Rechte in ${channel}.` }],
                    flags: [64],
                });
            }

            setGuildSettings(interaction.guildId, { musicChannelId: channel.id, musicPanelMsgId: null });

            await interaction.reply({
                embeds: [{ color: 0x5865F2, description: `✅ Musik-Kanal auf ${channel} gesetzt.\n\nDas Live-Panel erscheint dort gleich. Schreib einfach einen Songnamen in den Kanal um Musik abzuspielen!` }],
                flags: [64],
            });

            // Send initial idle panel.
            await updateMusicPanel(client, interaction.guildId, null);
            return;
        }

        if (sub === 'remove') {
            setGuildSettings(interaction.guildId, { musicChannelId: null, musicPanelMsgId: null });
            return interaction.reply({
                embeds: [{ color: 0x5865F2, description: '✅ Musik-Kanal entfernt.' }],
                flags: [64],
            });
        }

        if (sub === 'info') {
            const settings = getGuildSettings(interaction.guildId);
            const desc = settings.musicChannelId
                ? `🎵 Musik-Kanal: <#${settings.musicChannelId}>`
                : '❌ Kein Musik-Kanal gesetzt. Nutze `/musicchannel set` um einen festzulegen.';

            return interaction.reply({ embeds: [{ color: 0x5865F2, description: desc }], flags: [64] });
        }
    },
};

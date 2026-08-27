/**
 * Cleanup script to remove old embed spam messages from the music channel.
 * This finds and deletes individual track embeds that were spammed.
 */

const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent] });

client.once('ready', async () => {
    console.log('✅ Connected as', client.user.tag);
    
    try {
        // Read all guilds that might have music channels
        const guildIds = [
            // Add guild IDs here, or we scan all available guilds
        ];

        const guildsToScan = guildIds.length > 0 
            ? guildIds.map(id => client.guilds.cache.get(id)).filter(Boolean)
            : Array.from(client.guilds.cache.values());

        let totalDeleted = 0;

        for (const guild of guildsToScan) {
            console.log(`\n📍 Scanning guild: ${guild.name}`);
            
            // Find all text channels
            const channels = guild.channels.cache.filter(c => c.isTextBased());
            
            for (const [, channel] of channels) {
                try {
                    // Fetch messages from the last 100
                    let messages = await channel.messages.fetch({ limit: 100 });
                    let deleted = 0;

                    for (const [, msg] of messages) {
                        // Check if message has embeds with "Now Playing" title (the spam)
                        if (msg.embeds.length > 0) {
                            const hasSpamEmbed = msg.embeds.some(e => 
                                e.title === '🎵 Now Playing' && 
                                e.data?.fields?.length === 2  // Old format had Artist + Duration
                            );

                            if (hasSpamEmbed && msg.author.id === client.user.id) {
                                try {
                                    const embed = msg.embeds[0];
                                    await msg.delete();
                                    deleted++;
                                    totalDeleted++;
                                    console.log(`  🗑️  Deleted: ${embed.title} - ${embed.description?.slice(0, 40)}...`);
                                } catch (err) {
                                    console.error(`  ❌ Failed to delete message:`, err.message);
                                }
                            }
                        }
                    }

                    if (deleted > 0) {
                        console.log(`  ✅ Deleted ${deleted} spam messages from #${channel.name}`);
                    }
                } catch (err) {
                    console.error(`  ⚠️  Error scanning #${channel.name}:`, err.message);
                }
            }
        }

        console.log(`\n✅ Cleanup complete! Deleted ${totalDeleted} spam messages total.`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Cleanup error:', err);
        process.exit(1);
    }
});

client.login(process.env.DISCORD_TOKEN);

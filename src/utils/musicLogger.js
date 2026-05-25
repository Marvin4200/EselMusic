/**
 * EselMusic Discord Logger
 * Sends structured Embeds to a guild's configured log channel.
 *
 * Design principles:
 * - Silent on any channel/permission error (never crash the bot).
 * - Spam protection: same event per guild at most once per 30 s.
 * - track_started in 24/7/AutoMix: throttled to 5 minutes.
 * - No error stacks in Discord. Messages truncated at 200 characters.
 * - Ignored interaction codes (10062, 40060) never produce Discord alerts.
 */

const { getGuildSettings } = require('./config');

// ─── Constants ────────────────────────────────────────────────────────────────

const IGNORED_DISCORD_CODES = new Set([10062, 40060]);

const EVENT_COLORS = {
    info:     0x5865F2, // blurple
    warn:     0xFEE75C, // yellow
    error:    0xED4245, // red
    critical: 0xED4245,
};

/** Events and their default severity */
const EVENT_SEVERITY = {
    bot_start:                'info',
    lavalink_connected:       'info',
    lavalink_disconnected:    'warn',
    lavalink_error:           'error',
    track_started:            'info',
    twentyfourseven_enabled:  'info',
    twentyfourseven_disabled: 'info',
    rejoin_failed:            'warn',
    rejoin_disabled:          'warn',
    command_error:            'error',
};

/** Human-readable event titles */
const EVENT_TITLES = {
    bot_start:                'Bot gestartet',
    lavalink_connected:       'Lavalink verbunden',
    lavalink_disconnected:    'Lavalink getrennt',
    lavalink_error:           'Lavalink Fehler',
    track_started:            'Track gestartet',
    twentyfourseven_enabled:  '24/7 aktiviert',
    twentyfourseven_disabled: '24/7 deaktiviert',
    rejoin_failed:            'Rejoin fehlgeschlagen',
    rejoin_disabled:          'Rejoin gestoppt',
    command_error:            'Command Fehler',
};

/** Cooldown in ms between identical events for the same guild */
const COOLDOWN_DEFAULT_MS = 30_000;
/** track_started in 24/7 mode has a much longer cooldown */
const COOLDOWN_TRACK_247_MS = 5 * 60_000;

// ─── State ────────────────────────────────────────────────────────────────────

/** Map<`${guildId}:${event}`, number> → timestamp of last log send */
const lastLogTime = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the severity for an event string.
 * @param {string} event
 * @returns {'info'|'warn'|'error'|'critical'}
 */
function mapSeverity(event) {
    return EVENT_SEVERITY[event] || 'info';
}

/**
 * Truncates any value to a safe Discord string (max 200 chars).
 * @param {unknown} input
 * @returns {string}
 */
function sanitizeMessage(input) {
    const text = String(input ?? '').trim();
    if (text.length <= 200) return text;
    return text.slice(0, 197) + '…';
}

/**
 * Returns a safe, truncated error message — no stack trace.
 * @param {unknown} error
 * @returns {string}
 */
function safeErrorMessage(error) {
    const msg = error?.message || String(error || 'Unbekannter Fehler');
    return sanitizeMessage(msg);
}

/**
 * True if the error code should be silently ignored.
 * @param {unknown} error
 * @returns {boolean}
 */
function shouldIgnoreError(error) {
    return IGNORED_DISCORD_CODES.has(Number(error?.code));
}

/**
 * True if this event is still within its cooldown window.
 * @param {string} guildId  Empty string for global events.
 * @param {string} event
 * @param {boolean} [is247]
 * @returns {boolean}
 */
function isCoolingDown(guildId, event, is247 = false) {
    const key = `${guildId}:${event}`;
    const last = lastLogTime.get(key) || 0;
    const cooldown = (event === 'track_started' && is247)
        ? COOLDOWN_TRACK_247_MS
        : COOLDOWN_DEFAULT_MS;
    return (Date.now() - last) < cooldown;
}

function setCooldown(guildId, event) {
    lastLogTime.set(`${guildId}:${event}`, Date.now());
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Send a log embed to the guild's configured log channel.
 *
 * @param {import('discord.js').Client} client
 * @param {string|null} guildId  null/empty for global (bot-level) events
 * @param {string} event  One of the defined event keys
 * @param {object} [fields]
 * @param {string} [fields.channelId]
 * @param {string} [fields.userId]
 * @param {string} [fields.trackTitle]
 * @param {string} [fields.trackUri]    Shown only for track_started, non-critical
 * @param {string} [fields.reason]
 * @param {string} [fields.errorCode]
 * @param {string} [fields.description]  Free-form description override
 * @param {boolean} [fields.is247]       Whether this is a 24/7 context (affects cooldown)
 * @returns {Promise<void>}
 */
async function logEvent(client, guildId, event, fields = {}) {
    if (!client) return;

    const effectiveGuildId = guildId || '';
    const is247 = Boolean(fields.is247);

    // ── Cooldown check ──────────────────────────────────────────────────────
    if (isCoolingDown(effectiveGuildId, event, is247)) return;
    setCooldown(effectiveGuildId, event);

    // ── Resolve log channel ─────────────────────────────────────────────────
    let logChannelId = null;
    if (effectiveGuildId) {
        try {
            const settings = getGuildSettings(effectiveGuildId);
            logChannelId = settings.logChannelId;
        } catch {
            return;
        }
    }

    if (!logChannelId) return;

    let channel;
    try {
        channel = await client.channels.fetch(logChannelId);
    } catch (err) {
        if (!shouldIgnoreError(err)) {
            console.warn(`[MusicLogger] Cannot fetch log channel ${logChannelId} for guild ${effectiveGuildId}: ${safeErrorMessage(err)}`);
        }
        return;
    }
    if (!channel?.isTextBased()) return;

    // ── Build embed ─────────────────────────────────────────────────────────
    const severity = mapSeverity(event);
    const color = EVENT_COLORS[severity] ?? EVENT_COLORS.info;
    const title = `🎵 EselMusic — ${EVENT_TITLES[event] || event}`;

    const embedFields = [];

    if (fields.description) {
        // description is set as embed description, not a field
    }
    if (effectiveGuildId) {
        embedFields.push({ name: 'Guild', value: `\`${effectiveGuildId}\``, inline: true });
    }
    if (fields.channelId) {
        embedFields.push({ name: 'Channel', value: `<#${fields.channelId}>`, inline: true });
    }
    if (fields.userId) {
        embedFields.push({ name: 'User', value: `<@${fields.userId}>`, inline: true });
    }
    if (fields.trackTitle) {
        const trackDisplay = fields.trackUri
            ? `[${sanitizeMessage(fields.trackTitle)}](${fields.trackUri})`
            : sanitizeMessage(fields.trackTitle);
        embedFields.push({ name: 'Track', value: trackDisplay, inline: false });
    }
    if (fields.reason) {
        embedFields.push({ name: 'Grund', value: sanitizeMessage(fields.reason), inline: false });
    }
    if (fields.errorCode) {
        embedFields.push({ name: 'Code', value: sanitizeMessage(fields.errorCode), inline: true });
    }

    const embed = {
        color,
        title,
        timestamp: new Date().toISOString(),
        footer: { text: 'EselMusic Log' },
    };

    if (fields.description) {
        embed.description = sanitizeMessage(fields.description);
    }
    if (embedFields.length > 0) {
        embed.fields = embedFields;
    }

    // ── Send ─────────────────────────────────────────────────────────────────
    try {
        await channel.send({ embeds: [embed] });
    } catch (err) {
        if (shouldIgnoreError(err)) return;
        console.warn(`[MusicLogger] Failed to send log for event "${event}" in guild ${effectiveGuildId}: ${safeErrorMessage(err)}`);
    }
}

module.exports = {
    logEvent,
    sanitizeMessage,
    safeErrorMessage,
    shouldIgnoreError,
    mapSeverity,
};

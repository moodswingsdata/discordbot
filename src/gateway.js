/**
 * Discord gateway bot for detecting [[card name]] patterns in messages.
 *
 * This script runs as a standalone Node.js process alongside the Cloudflare
 * Worker.  It connects to the Discord Gateway via WebSocket and listens for
 * MESSAGE_CREATE events.  Whenever a message contains one or more [[card name]]
 * references it looks up each card and posts the result to the same channel,
 * exactly as if the user had typed `/feel <card name>`.
 *
 * Required environment variables (same .env file as the rest of the project):
 *   DISCORD_TOKEN      - bot token
 *   DISCORD_APP_ID     - application/client ID
 */

import WebSocket from 'ws';
import dotenv from 'dotenv';
import process from 'node:process';
import { fuzzyMatchCard, buildCardResponseData } from './cards.js';

dotenv.config({ path: '.env' });

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    throw new Error('The DISCORD_TOKEN environment variable is required.');
}

// Gateway intents:
//   GUILDS (1 << 0) = 1
//   GUILD_MESSAGES (1 << 9) = 512
//   DIRECT_MESSAGES (1 << 12) = 4096
//   MESSAGE_CONTENT (1 << 15) = 32_768
const GATEWAY_INTENTS = 1 | 512 | 4096 | 32_768;

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Allowed hostname pattern for gateway resume URLs to prevent open redirects.
// Matches discord.gg and any subdomain (e.g. gateway.discord.gg, us-west-1.gateway.discord.gg).
const ALLOWED_GATEWAY_HOST = /^([a-z0-9-]+\.)*discord\.gg$/;

// Discord heartbeat interval bounds (ms): clamp to [5s, 60s] for safety.
const HEARTBEAT_MIN_MS = 5_000;
const HEARTBEAT_MAX_MS = 60_000;

// Regex to find all [[card name]] occurrences in a message
const DOUBLE_BRACKET_PATTERN = /\[\[([^\]]+)\]\]/g;

let lastSequence = null;
let sessionId = null;
let resumeGatewayUrl = null;

function safeGatewayUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'wss:' && ALLOWED_GATEWAY_HOST.test(parsed.hostname)) {
            // Reconstruct from parsed parts so the returned value is not tainted
            // by the original user-provided string.
            return `wss://${parsed.host}/?v=10&encoding=json`;
        }
    } catch {
        // invalid URL
    }
    console.warn(`Ignoring suspicious resume_gateway_url: ${url}`);
    return GATEWAY_URL;
}

// Discord snowflake IDs are unsigned 64-bit integers represented as decimal strings.
const SNOWFLAKE_PATTERN = /^\d{1,20}$/;

async function postCardToChannel(channelId, cardSearch) {
    // Validate that channelId is a Discord snowflake before using it in the URL.
    if (!SNOWFLAKE_PATTERN.test(channelId)) {
        console.warn(`Ignoring invalid channel_id: ${channelId}`);
        return;
    }

    const searchResult = fuzzyMatchCard(cardSearch);
    if (!searchResult.match) {
        return;
    }
    const introText = `"${cardSearch}" found a match.`;
    const data = buildCardResponseData(introText, searchResult);

    const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bot ${DISCORD_TOKEN}`,
        },
        body: JSON.stringify(data),
    });
    if (!response.ok) {
        const text = await response.text();
        console.error(`Failed to post card to channel ${channelId}: ${response.status} ${text}`);
    }
}

function connect(url) {
    const ws = new WebSocket(url);
    let heartbeatInterval;

    function sendJson(payload) {
        ws.send(JSON.stringify(payload));
    }

    function startHeartbeat(intervalMs) {
        const clampedMs = Math.min(Math.max(intervalMs, HEARTBEAT_MIN_MS), HEARTBEAT_MAX_MS);
        heartbeatInterval = setInterval(() => {
            sendJson({ op: 1, d: lastSequence });
        }, clampedMs);
    }

    function identify() {
        sendJson({
            op: 2,
            d: {
                token: DISCORD_TOKEN,
                intents: GATEWAY_INTENTS,
                properties: {
                    os: 'linux',
                    browser: 'feelingsbot',
                    device: 'feelingsbot',
                },
            },
        });
    }

    async function handleMessage(data) {
        const payload = JSON.parse(data);
        const { op, d, s, t } = payload;

        if (s !== null && s !== undefined) {
            lastSequence = s;
        }

        switch (op) {
            case 10: // Hello — start heartbeating then identify/resume
                startHeartbeat(d.heartbeat_interval);
                if (sessionId && resumeGatewayUrl) {
                    sendJson({
                        op: 6,
                        d: { token: DISCORD_TOKEN, session_id: sessionId, seq: lastSequence },
                    });
                } else {
                    identify();
                }
                break;

            case 11: // Heartbeat ACK
                break;

            case 1: // Heartbeat request from server
                sendJson({ op: 1, d: lastSequence });
                break;

            case 7: // Reconnect — Discord wants us to reconnect and resume
                console.log('Gateway requested reconnect.');
                ws.close(1000);
                connect(safeGatewayUrl(resumeGatewayUrl) || GATEWAY_URL);
                break;

            case 9: // Invalid session — must re-identify after a short delay
                console.log('Invalid session, re-identifying.');
                sessionId = null;
                resumeGatewayUrl = null;
                lastSequence = null;
                setTimeout(identify, 5000);
                break;

            case 0: // Dispatch
                if (t === 'READY') {
                    sessionId = d.session_id;
                    resumeGatewayUrl = safeGatewayUrl(d.resume_gateway_url);
                    console.log(`Gateway ready. Logged in as ${d.user.username}.`);
                } else if (t === 'MESSAGE_CREATE') {
                    // Ignore messages from bots (including ourselves)
                    if (d.author?.bot) break;

                    const content = d.content || '';
                    if (content.length == 0) { console.log("empty content; make sure privileged intent 'Message Content' is on"); }
                    const channelId = d.channel_id;
                    const matches = [...content.matchAll(DOUBLE_BRACKET_PATTERN)];
                    const lookups = matches
                        .map((m) => m[1].trim())
                        .filter((s) => s.length > 0)
                        .map((cardSearch) => postCardToChannel(channelId, cardSearch));
                    await Promise.all(lookups);
                }
                break;

            default:
                break;
        }
    }

    ws.on('message', (data) => {
        handleMessage(data.toString()).catch((err) => {
            console.error('Error handling gateway message:', err);
        });
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} ${reason}`);
        clearInterval(heartbeatInterval);
        // Reconnect after a short delay on unexpected disconnects
        if (code !== 1000) {
            setTimeout(() => connect(safeGatewayUrl(resumeGatewayUrl) || GATEWAY_URL), 5000);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });

    ws.on('open', () => {
        console.log(`Connected to Discord gateway at ${url}`);
    });
}

connect(GATEWAY_URL);

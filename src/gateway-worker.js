/**
 * Discord gateway bot as a Cloudflare Worker + Durable Object.
 *
 * A Durable Object keeps a single outbound WebSocket connection open to the
 * Discord gateway.  Heartbeats are driven by Durable Object Alarms so the
 * connection survives periods of low activity.  A cron trigger fires every
 * 5 minutes to reconnect the DO if it was evicted while the socket was idle.
 *
 * Deploy:
 *   npx wrangler deploy --config wrangler-gateway.toml
 *
 * Required secret (run once after deploying):
 *   npx wrangler secret put DISCORD_TOKEN --config wrangler-gateway.toml
 *
 * NOTE: Discord restricts gateway connections from some data-center IP ranges,
 * including Cloudflare's shared egress pool.  If you receive a 401 on the
 * initial WebSocket upgrade, run the gateway on a non-datacenter host instead:
 *   npm run gateway
 */

import { fuzzyMatchCard, buildCardResponseData } from './cards.js';

// Gateway intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const GATEWAY_INTENTS = 1 | 512 | 4096 | 32_768;
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const ALLOWED_GATEWAY_HOST = /^([a-z0-9]+(-[a-z0-9]+)*\.)*discord\.gg$/;
const HEARTBEAT_MIN_MS = 5_000;
const HEARTBEAT_MAX_MS = 60_000;
// Discord's documented default; used when storage has no recorded interval yet.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 41_250;
const RECONNECT_DELAY_MS = 5_000;
const DOUBLE_BRACKET_PATTERN = /\[\[([^\]]+)\]\]/g;
const SNOWFLAKE_PATTERN = /^\d{1,20}$/;
const DISCORD_API_BASE = 'https://discord.com/api/v10';

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

/**
 * Durable Object that owns a single persistent Discord gateway WebSocket.
 *
 * Session state (sequence number, session ID, resume URL, heartbeat interval)
 * is written to Durable Object Storage so that a resumable Discord session
 * survives DO eviction and restart.  Heartbeats are driven by DO Alarms.
 */
export class DiscordGateway {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        /** @type {WebSocket|null} active outbound socket, null when evicted */
        this.ws = null;
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/connect') {
            await this.ensureConnected();
            return new Response('OK');
        }
        return new Response('Not Found', { status: 404 });
    }

    /** Opens a new connection only when none is currently active. */
    async ensureConnected() {
        if (this.ws && this.ws.readyState === 1 /* OPEN */) {
            return;
        }
        try {
            const resumeGatewayUrl = await this.state.storage.get('resumeGatewayUrl');
            await this.connect(resumeGatewayUrl ?? GATEWAY_URL);
        } catch (err) {
            console.error('ensureConnected failed, scheduling alarm retry:', err);
            // Guarantee the alarm chain is alive so we retry later.
            await this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
        }
    }

    async connect(url) {
        // Workers fetch() requires https:// even for WebSocket upgrades;
        // the Upgrade header handles the protocol switch.
        const fetchUrl = url.replace(/^wss:\/\//, 'https://');
        const response = await fetch(fetchUrl, {
            headers: { Upgrade: 'websocket' },
        });
        if (response.status !== 101) {
            throw new Error(
                `Gateway upgrade failed with status ${response.status}. ` +
                `Discord may be blocking this IP range — try 'npm run gateway' on a non-datacenter host instead.`,
            );
        }
        this.ws = response.webSocket;
        this.ws.accept();

        this.ws.addEventListener('message', (event) => {
            this.handleMessage(event.data).catch((err) => {
                console.error('Error handling gateway message:', err);
            });
        });

        this.ws.addEventListener('close', (event) => {
            console.log(`WebSocket closed: ${event.code} ${event.reason ?? ''}`);
            this.ws = null;
            if (event.code !== 1000) {
                // Schedule a reconnect via alarm.
                this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS).catch(console.error);
            }
        });

        this.ws.addEventListener('error', (event) => {
            console.error('WebSocket error:', event.message ?? event);
        });

        console.log(`Connected to Discord gateway at ${url}`);
    }

    identify() {
        this.ws.send(JSON.stringify({
            op: 2,
            d: {
                token: this.env.DISCORD_TOKEN,
                intents: GATEWAY_INTENTS,
                properties: { os: 'linux', browser: 'feelingsbot', device: 'feelingsbot' },
            },
        }));
    }

    async handleMessage(data) {
        const { op, d, s, t } = JSON.parse(data);

        if (s !== null && s !== undefined) {
            await this.state.storage.put('lastSequence', s);
        }

        switch (op) {
            case 10: { // Hello — start heartbeating then identify or resume
                const intervalMs = Math.min(
                    Math.max(d.heartbeat_interval, HEARTBEAT_MIN_MS),
                    HEARTBEAT_MAX_MS,
                );
                await this.state.storage.put('heartbeatIntervalMs', intervalMs);
                await this.state.storage.setAlarm(Date.now() + intervalMs);

                const [sessionId, resumeGatewayUrl, lastSequence] = await Promise.all([
                    this.state.storage.get('sessionId'),
                    this.state.storage.get('resumeGatewayUrl'),
                    this.state.storage.get('lastSequence'),
                ]);
                if (sessionId && resumeGatewayUrl) {
                    this.ws.send(JSON.stringify({
                        op: 6,
                        d: { token: this.env.DISCORD_TOKEN, session_id: sessionId, seq: lastSequence ?? null },
                    }));
                } else {
                    this.identify();
                }
                break;
            }

            case 11: // Heartbeat ACK — no action needed
                break;

            case 1: { // Heartbeat request from server
                const lastSequence = await this.state.storage.get('lastSequence');
                this.ws.send(JSON.stringify({ op: 1, d: lastSequence ?? null }));
                break;
            }

            case 7: // Reconnect — Discord wants us to reconnect and resume
                console.log('Gateway requested reconnect.');
                this.ws.close(1001, 'Reconnecting per server request');
                break;

            case 9: { // Invalid session — clear state and re-identify after delay
                console.log('Invalid session, re-identifying after delay.');
                await Promise.all([
                    this.state.storage.delete('sessionId'),
                    this.state.storage.delete('resumeGatewayUrl'),
                    this.state.storage.delete('lastSequence'),
                    this.state.storage.put('pendingIdentify', true),
                ]);
                await this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
                break;
            }

            case 0: // Dispatch
                if (t === 'READY') {
                    await Promise.all([
                        this.state.storage.put('sessionId', d.session_id),
                        this.state.storage.put('resumeGatewayUrl', safeGatewayUrl(d.resume_gateway_url)),
                    ]);
                    console.log(`Gateway ready. Logged in as ${d.user.username}.`);
                } else if (t === 'RESUMED') {
                    console.log('Session resumed.');
                } else if (t === 'MESSAGE_CREATE') {
                    if (d.author?.bot) break;
                    const matches = [...(d.content ?? '').matchAll(DOUBLE_BRACKET_PATTERN)];
                    await Promise.all(
                        matches
                            .map((m) => m[1].trim())
                            .filter((name) => name.length > 0)
                            .map((name) => this.postCardToChannel(d.channel_id, name)),
                    );
                }
                break;

            default:
                break;
        }
    }

    async alarm() {
        try {
            // Alarm may be for a pending re-identify (after invalid session).
            const pendingIdentify = await this.state.storage.get('pendingIdentify');
            if (pendingIdentify) {
                await this.state.storage.delete('pendingIdentify');
                if (this.ws && this.ws.readyState === 1 /* OPEN */) {
                    this.identify();
                    // Discord won't send another HELLO on this connection, so
                    // we must restart the heartbeat alarm chain ourselves.
                    const intervalMs = (await this.state.storage.get('heartbeatIntervalMs')) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
                    await this.state.storage.setAlarm(Date.now() + intervalMs);
                } else {
                    await this.connect(GATEWAY_URL);
                }
                return;
            }

            // Reconnect if the socket is gone (e.g. after DO eviction or unexpected close).
            if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
                const resumeGatewayUrl = await this.state.storage.get('resumeGatewayUrl');
                await this.connect(resumeGatewayUrl ?? GATEWAY_URL);
                return;
            }

            // Regular heartbeat — send and reschedule.
            const lastSequence = await this.state.storage.get('lastSequence');
            this.ws.send(JSON.stringify({ op: 1, d: lastSequence ?? null }));
            const intervalMs = (await this.state.storage.get('heartbeatIntervalMs')) ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
            await this.state.storage.setAlarm(Date.now() + intervalMs);
        } catch (err) {
            console.error('Alarm handler error, scheduling retry:', err);
            // Always ensure the alarm chain continues so the DO doesn't go dormant.
            await this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
        }
    }

    async postCardToChannel(channelId, cardSearch) {
        if (!SNOWFLAKE_PATTERN.test(channelId)) {
            console.warn(`Ignoring invalid channel_id: ${channelId}`);
            return;
        }
        const searchResult = fuzzyMatchCard(cardSearch);
        if (!searchResult.match) {
            await fetch(
                `${DISCORD_API_BASE}/channels/${channelId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
                    },
                    body: JSON.stringify({ content: `No match found for "${cardSearch}".` }),
                },
            );
            return;
        }

        const response = await fetch(
            `${DISCORD_API_BASE}/channels/${channelId}/messages`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
                },
                body: JSON.stringify(
                    buildCardResponseData(`"${cardSearch}" found a match.`, searchResult),
                ),
            },
        );
        if (!response.ok) {
            console.error(`Failed to post card: ${response.status} ${await response.text()}`);
        }
    }
}

// Worker entry point: HTTP hits and cron trigger both call ensureConnected().
// They also act as a safety net — if the alarm chain broke, this re-establishes it.
export default {
    async fetch(_request, env) {
        const id = env.DISCORD_GATEWAY.idFromName('singleton');
        await env.DISCORD_GATEWAY.get(id).fetch(new Request('https://do/connect'));
        return new Response('Gateway connection checked');
    },

    async scheduled(_event, env) {
        const id = env.DISCORD_GATEWAY.idFromName('singleton');
        await env.DISCORD_GATEWAY.get(id).fetch(new Request('https://do/connect'));
    },
};

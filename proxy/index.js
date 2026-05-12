'use strict';

/**
 * Stream Lazarus Proxy v2
 *
 * Sits transparently between Nginx and SillyTavern.  All traffic is forwarded
 * unchanged — except POST /api/backends/:backend/generate, which is intercepted
 * to keep the upstream AI connection alive even when the iOS client drops.
 *
 * When a generate stream completes after the client disconnected, the proxy
 * marks the stream as complete.  The iOS client polls /_slproxy/reconnect/:id
 * on resume; on completion it calls ST's reloadCurrentChat() which fetches the
 * response ST already saved to disk (the loopback connection kept ST alive).
 *
 * Environment variables:
 *   ST_HOST    — SillyTavern hostname inside Docker network (default: sillytavern)
 *   ST_PORT    — SillyTavern port                          (default: 8000)
 *   PROXY_PORT — Port this proxy listens on                (default: 3000)
 */

const http    = require('http');
const crypto  = require('crypto');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

/* ─── Config ────────────────────────────────────────────────────── */

const ST_HOST    = process.env.ST_HOST    || 'sillytavern';
const ST_PORT    = parseInt(process.env.ST_PORT    || '8000', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);

const VERSION    = '2.0.0';
const EXPIRY_MS  = 30 * 60 * 1000;   // stream entries expire after 30 min
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB safety cap on buffered SSE text

const ST_ORIGIN = `http://${ST_HOST}:${ST_PORT}`;

/* ─── Hop-by-hop headers (must not be forwarded) ────────────────── */

const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/* ─── Stream state ──────────────────────────────────────────────── */

/**
 * @typedef {{ buf: string, complete: boolean, overflow: boolean,
 *             waiters: Set<Waiter>, ts: number }} StreamEntry
 * @typedef {{ res: import('express').Response,
 *             timer: ReturnType<typeof setTimeout> }} Waiter
 */

/** @type {Map<string, StreamEntry>} */
const streams = new Map();

/* ─── Helper: complete a stream and notify long-poll waiters ─────── */

function completeStream(streamId) {
    const entry = streams.get(streamId);
    if (!entry || entry.complete) return;
    entry.complete = true;
    console.log(`[SLProxy] Stream ${streamId}: complete (${entry.buf.length} chars buffered)`);
    for (const w of entry.waiters) {
        clearTimeout(w.timer);
        try { w.res.json({ found: true, complete: true }); } catch { /* client gone */ }
    }
    entry.waiters.clear();
    // Keep the entry briefly so a reconnect that arrives right after
    // completeStream() still gets {complete: true}, then clean up.
    setTimeout(() => streams.delete(streamId), EXPIRY_MS);
}

/* ─── Express app ───────────────────────────────────────────────── */

const app = express();

/* ── Management endpoints ─────────────────────────────────────────
 *
 * These live at /_slproxy/* so they never clash with ST's own routes.
 * The transparent proxy middleware at the bottom of this file only
 * handles requests that fall through — i.e. anything that did NOT
 * match these routes.
 */

app.get('/_slproxy/health', (_req, res) =>
    res.json({ ok: true, version: VERSION }));

/* Reconnect endpoint — called by the iOS client when it returns.
 *
 * If the stream is already complete: respond immediately.
 * If still generating: hold the connection open (long-poll) until
 * the stream finishes or a 5-minute timeout expires.
 */
app.get('/_slproxy/reconnect/:id', (req, res) => {
    const entry = streams.get(req.params.id);
    if (!entry || Date.now() - entry.ts > EXPIRY_MS) {
        streams.delete(req.params.id);
        return res.json({ found: false });
    }
    if (entry.complete) {
        return res.json({ found: true, complete: true });
    }

    // Long-poll: park this response until completeStream() wakes it.
    /** @type {Waiter} */
    const w = { res, timer: null };
    w.timer = setTimeout(() => {
        entry.waiters.delete(w);
        try { res.json({ found: true, complete: false, timeout: true }); } catch {}
    }, 5 * 60 * 1000);
    entry.waiters.add(w);

    req.on('close', () => {
        clearTimeout(w.timer);
        entry.waiters.delete(w);
    });
});

/* Explicit stream clear (called when a normal recovery confirms success) */
app.delete('/_slproxy/stream/:id', (req, res) => {
    streams.delete(req.params.id);
    res.json({ ok: true });
});

/* ── Generate interception ────────────────────────────────────────
 *
 * express.json() is applied ONLY to this route.  All other POST
 * bodies remain as raw streams so http-proxy-middleware can forward
 * them unchanged.
 */
app.post(
    /^\/api\/.*\/generate\/?$/,
    express.raw({ type: '*/*', limit: '50mb' }),
    (req, res) => {
        // Prefer the client-provided stream ID (so it doesn't matter if iOS drops the connection before headers)
        const streamId = req.headers['x-sl-stream-id'] || crypto.randomUUID();

        /** @type {StreamEntry} */
        const entry = {
            buf:      '',
            complete: false,
            overflow: false,
            waiters:  new Set(),
            ts:       Date.now(),
        };
        streams.set(streamId, entry);

        // Set the stream ID header BEFORE any response bytes are written,
        // so the client fetch interceptor can read it from the response headers.
        res.setHeader('X-SL-Stream-Id', streamId);

        // Pass the raw body buffer downstream (supports multimodal images).
        const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

        // Build forwarded headers: strip hop-by-hop and fix host/length.
        const fwd = {};
        for (const [k, v] of Object.entries(req.headers)) {
            const lk = k.toLowerCase();
            if (HOP_BY_HOP.has(lk) || lk === 'host' || lk === 'content-length') continue;
            fwd[k] = v;
        }
        fwd['host']           = `${ST_HOST}:${ST_PORT}`;
        fwd['content-length'] = String(bodyBuf.length);

        // Track whether the iOS client is still connected.
        let clientAlive = true;
        res.on('close', () => { clientAlive = false; });

        const loopReq = http.request(
            { hostname: ST_HOST, port: ST_PORT, path: req.url, method: 'POST', headers: fwd },
            loopRes => {
                // Forward status + safe headers to the client (while connected).
                if (!res.headersSent) {
                    res.statusCode = loopRes.statusCode || 200;
                    for (const [k, v] of Object.entries(loopRes.headers)) {
                        const lk = k.toLowerCase();
                        if (HOP_BY_HOP.has(lk) || lk === 'content-length') continue;
                        try { res.setHeader(k, v); } catch { /* ignore invalid headers */ }
                    }
                }

                loopRes.on('data', chunk => {
                    // Always buffer (for recovery), up to the cap.
                    if (!entry.overflow) {
                        entry.buf += chunk.toString('utf8');
                        if (entry.buf.length > MAX_BUFFER) {
                            entry.overflow = true;
                            console.warn(`[SLProxy] Stream ${streamId}: buffer overflow — text recovery unavailable`);
                        }
                    }
                    // Forward to the iOS client while it is still connected.
                    if (clientAlive) {
                        try {
                            if (!res.writableEnded) res.write(chunk);
                        } catch { clientAlive = false; }
                    }
                });

                loopRes.on('end', () => {
                    if (clientAlive && !res.writableEnded) res.end();
                    completeStream(streamId);
                });

                loopRes.on('error', err => {
                    console.error(`[SLProxy] Loopback response error (${streamId}):`, err.message);
                    if (!res.writableEnded) res.end();
                    completeStream(streamId);
                });
            }
        );

        loopReq.on('error', err => {
            console.error(`[SLProxy] Loopback request error (${streamId}):`, err.message);
            if (!res.headersSent) res.status(502).json({ error: err.message });
            else if (!res.writableEnded) res.end();
            completeStream(streamId);
        });

        loopReq.write(bodyBuf);
        loopReq.end();
    }
);

/* ── Transparent passthrough for all other traffic ───────────────
 *
 * This must be last — it catches everything that didn't match above.
 * It forwards the raw request stream unchanged, so body parsing is
 * never needed (and is never applied) here.
 */
const stProxy = createProxyMiddleware({
    target:       ST_ORIGIN,
    changeOrigin: false,
    ws:           true,
    on: {
        error: (err, _req, res) => {
            console.error('[SLProxy] Proxy error:', err.message);
            try {
                if (!res.headersSent) res.status(502).send('Upstream unavailable');
            } catch { /* already sent */ }
        },
    },
});

app.use('/', stProxy);

/* ─── HTTP server ───────────────────────────────────────────────── */

const server = http.createServer(app);

// Forward WebSocket upgrade requests (e.g. any WS connections ST uses).
server.on('upgrade', stProxy.upgrade);

server.listen(PROXY_PORT, () =>
    console.log(`[SLProxy] v${VERSION} — :${PROXY_PORT} → ${ST_ORIGIN}`));

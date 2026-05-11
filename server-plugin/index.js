'use strict';

/**
 * Stream Lazarus — Server Plugin
 *
 * Proxies AI generate requests so the upstream API call stays alive even when
 * the iOS client drops the TCP connection mid-stream.  When a disconnected
 * client's generation completes the plugin stores the extracted text in memory
 * (keyed by chat ID) and exposes it via a /result/:chatId endpoint.  The UI
 * extension polls this endpoint on recovery and shows the user a modal with the
 * text they missed.
 *
 * Installation
 * ────────────
 * 1. Copy this folder (stream-lazarus/) into SillyTavern/plugins/
 * 2. In config.yaml set:  enableServerPlugins: true
 * 3. Restart SillyTavern
 * 4. The UI extension will auto-detect the plugin on next load.
 *
 * Routes (all under /api/plugins/stream-lazarus/)
 * ────────────────────────────────────────────────
 *   GET  /health              — liveness check; returns {ok:true,version}
 *   POST /generate?backend=X  — proxies to /api/backends/{X}/generate
 *   GET  /result/:chatId      — retrieve (and clear) stored result
 *   DELETE /result/:chatId    — explicitly clear stored result
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

/* ─── Constants ────────────────────────────────────────────────── */

/** Hop-by-hop headers that must never be forwarded. */
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/** Maximum SSE buffer size per request (10 MB). Larger responses are NOT stored. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Results expire after 30 minutes. */
const RESULT_EXPIRY_MS = 30 * 60 * 1000;

const PLUGIN_VERSION = '1.0.0';

/* ─── Runtime state ────────────────────────────────────────────── */

/** @type {Map<string, {text: string, timestamp: number}>} */
const results = new Map();

let serverPort   = 8000;
let serverSecure = false;

/* ─── Plugin metadata ──────────────────────────────────────────── */

const info = {
    id:          'stream-lazarus',
    name:        'Stream Lazarus',
    description: 'Keeps AI generation alive when iOS drops the connection, enabling response recovery.',
};

/* ─── init ─────────────────────────────────────────────────────── */

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    // Try to read the server port from config.yaml so loopback requests work
    // correctly even before the first /health request arrives.
    try {
        const configPath = path.join(process.cwd(), 'config.yaml');
        if (fs.existsSync(configPath)) {
            const configText = fs.readFileSync(configPath, 'utf8');
            const portMatch = configText.match(/^port:\s*(\d+)/m);
            if (portMatch) serverPort = parseInt(portMatch[1], 10);
            if (/^  enabled:\s*true/m.test(configText) && configText.includes('ssl:')) {
                serverSecure = true;
            }
        }
    } catch (e) {
        console.warn('[StreamLazarus] Could not read config.yaml:', e.message);
    }

    // ── Health check ──────────────────────────────────────────────
    router.get('/health', (req, res) => {
        // Capture actual port from the live socket (most reliable).
        serverPort   = req.socket.localPort || serverPort;
        serverSecure = req.secure           || serverSecure;
        res.json({ ok: true, version: PLUGIN_VERSION });
    });

    // ── Generate proxy ────────────────────────────────────────────
    router.post('/generate', async (req, res) => {
        serverPort   = req.socket.localPort || serverPort;
        serverSecure = req.secure           || serverSecure;

        // Sanitise the backend param to prevent path traversal.
        const backend = String(req.query.backend || 'chat-completions').replace(/[^a-z0-9-]/g, '');
        const chatId  = req.headers['x-sl-chat-id'] || null;

        await proxyGenerate(req, res, backend, chatId);
    });

    // ── Result retrieval (destructive) ────────────────────────────
    router.get('/result/:chatId', (req, res) => {
        const { chatId } = req.params;
        const entry = results.get(chatId);
        if (entry && Date.now() - entry.timestamp < RESULT_EXPIRY_MS) {
            results.delete(chatId);
            return res.json({ found: true, text: entry.text });
        }
        results.delete(chatId); // clear any stale entry
        res.json({ found: false });
    });

    // ── Explicit clear ────────────────────────────────────────────
    router.delete('/result/:chatId', (req, res) => {
        results.delete(req.params.chatId);
        res.json({ ok: true });
    });

    console.log(`[StreamLazarus] Plugin v${PLUGIN_VERSION} loaded. Proxy target: ${serverSecure ? 'https' : 'http'}://127.0.0.1:${serverPort}`);
}

/* ─── Proxy logic ──────────────────────────────────────────────── */

/**
 * Forward a generate request to ST's own backend via loopback.
 * The loopback connection is independent of the client (iOS) socket, so when
 * iOS drops its connection the upstream API call continues uninterrupted.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {string}      backend  ST backend name (e.g. 'chat-completions')
 * @param {string|null} chatId   Used as the key to store the generated text
 */
async function proxyGenerate(req, res, backend, chatId) {
    const bodyJson   = JSON.stringify(req.body);
    const bodyBuffer = Buffer.from(bodyJson, 'utf8');

    // Build forwarded headers — strip hop-by-hop and our custom SL headers,
    // then correct Host and Content-Length for the re-serialised body.
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (lk === 'host' || lk === 'content-length') continue;
        if (lk.startsWith('x-sl-')) continue;
        forwardHeaders[k] = v;
    }
    forwardHeaders['host']           = `127.0.0.1:${serverPort}`;
    forwardHeaders['content-type']   = 'application/json';
    forwardHeaders['content-length'] = String(bodyBuffer.length);

    const transport = serverSecure ? https : http;
    const options   = {
        hostname: '127.0.0.1',
        port:     serverPort,
        path:     `/api/backends/${backend}/generate`,
        method:   'POST',
        headers:  forwardHeaders,
    };
    if (serverSecure) {
        options.agent = new https.Agent({ rejectUnauthorized: false });
    }

    // Track whether the iOS client is still connected.
    let clientConnected = true;
    const chunks = [];
    let totalBytes = 0;
    let overflow   = false;

    req.on('close', () => {
        if (!res.writableEnded) {
            clientConnected = false;
            console.log(`[StreamLazarus] Client disconnected for chat "${chatId}" — continuing generation in background`);
        }
    });
    res.on('error', () => { clientConnected = false; });

    return new Promise((resolve) => {
        const loopReq = transport.request(options, (loopRes) => {

            // Forward status + safe headers to the iOS client.
            if (!res.headersSent) {
                res.statusCode = loopRes.statusCode || 200;
                for (const [k, v] of Object.entries(loopRes.headers)) {
                    const lk = k.toLowerCase();
                    if (HOP_BY_HOP.has(lk) || lk === 'content-length') continue;
                    try { res.setHeader(k, v); } catch { /* ignore */ }
                }
            }

            loopRes.on('data', (chunk) => {
                // Buffer the SSE for post-disconnect result extraction.
                if (!overflow) {
                    totalBytes += chunk.length;
                    if (totalBytes <= MAX_BUFFER_BYTES) {
                        chunks.push(chunk);
                    } else {
                        overflow = true;
                        console.warn('[StreamLazarus] Response too large to buffer — result will not be stored');
                    }
                }

                // Stream to iOS client while it is still connected.
                if (clientConnected) {
                    try {
                        if (!res.writableEnded && !res.destroyed) res.write(chunk);
                    } catch {
                        clientConnected = false;
                    }
                }
            });

            loopRes.on('end', () => {
                if (clientConnected && !res.writableEnded) res.end();

                // If the client dropped mid-stream, parse and store the result.
                if (!clientConnected && !overflow && chunks.length > 0 && chatId) {
                    const sseText       = Buffer.concat(chunks).toString('utf8');
                    const generatedText = parseSSEText(sseText);
                    if (generatedText) {
                        results.set(chatId, { text: generatedText, timestamp: Date.now() });
                        console.log(`[StreamLazarus] Stored ${generatedText.length} chars for chat "${chatId}"`);
                    } else {
                        console.warn(`[StreamLazarus] Could not extract text from SSE for chat "${chatId}"`);
                    }
                }

                resolve();
            });

            loopRes.on('error', (err) => {
                console.error('[StreamLazarus] Loopback response error:', err.message);
                if (!res.writableEnded) res.end();
                resolve();
            });
        });

        loopReq.on('error', (err) => {
            console.error('[StreamLazarus] Loopback request error:', err.message);
            if (!res.headersSent) res.status(502).json({ error: true, message: err.message });
            resolve();
        });

        loopReq.write(bodyBuffer);
        loopReq.end();
    });
}

/* ─── SSE text extractor ───────────────────────────────────────── */

/**
 * Parse raw SSE data and extract the concatenated AI text.
 * Handles OpenAI/OpenRouter, Claude (direct), and Gemini formats.
 *
 * @param {string} sseData
 * @returns {string}
 */
function parseSSEText(sseData) {
    let text = '';
    for (const line of sseData.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let json;
        try { json = JSON.parse(data); } catch { continue; }

        // OpenAI / most providers (OpenRouter, Mistral, DeepSeek, xAI, etc.)
        const oaiDelta = json?.choices?.[0]?.delta?.content;
        if (typeof oaiDelta === 'string') { text += oaiDelta; continue; }

        // Claude direct API — content_block_delta events carry text_delta
        if (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta') {
            text += json.delta.text ?? '';
            continue;
        }

        // Gemini (as proxied by ST's generate endpoint)
        const geminiText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof geminiText === 'string') { text += geminiText; continue; }
    }
    return text.trim();
}

/* ─── exit ─────────────────────────────────────────────────────── */

async function exit() {
    results.clear();
    console.log('[StreamLazarus] Plugin shut down.');
}

/* ─── exports ──────────────────────────────────────────────────── */

module.exports = { init, exit, info };

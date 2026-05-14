/**
 * Stream Lazarus v2 — SillyTavern Mobile Stream Recovery Extension
 *
 * Works in conjunction with the standalone Stream Lazarus proxy container.
 * The proxy sits between Nginx and ST and keeps the upstream AI connection
 * alive even when iOS drops the browser's TCP connection mid-generation.
 *
 * This extension's only jobs:
 *   1. Observe generate responses and capture the X-SL-Stream-Id header.
 *   2. Persist {chatId, streamId} to localStorage (survives full page kill).
 *   3. On visibility restore: reconnect to the proxy and reload the chat.
 *   4. On normal completion: clear localStorage so no recovery is attempted.
 */

const MODULE_NAME = 'stream_lazarus';
const LOG_PREFIX  = '[StreamLazarus]';
const STORAGE_KEY = 'sl_pending';
const EXPIRY_MS   = 30 * 60 * 1000; // 30 minutes

/* ─── Default settings ────────────────────────────────────────── */

const DEFAULT_SETTINGS = Object.freeze({ enabled: true, autoInsert: false, mobileOnly: true });

/* ─── Module state ────────────────────────────────────────────── */

let proxyActive            = false;
let recovering             = false;
let originalFetch          = null;
let fetchInterceptorActive = false;

/* ─── Settings ────────────────────────────────────────────────── */

function getSettings() {
    const ctx = SillyTavern.getContext();
    ctx.extensionSettings[MODULE_NAME] ??= {};
    return Object.assign(structuredClone(DEFAULT_SETTINGS), ctx.extensionSettings[MODULE_NAME]);
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/* ─── localStorage ────────────────────────────────────────────── */

function savePending(chatId, streamId) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            chatId, streamId, timestamp: Date.now(),
        }));
        log('Pending saved — chatId:', chatId, 'streamId:', streamId);
    } catch (e) {
        console.warn(LOG_PREFIX, 'Could not save pending:', e.message);
    }
}

function loadPending() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (Date.now() - p.timestamp > EXPIRY_MS) { clearPending(); return null; }
        return p;
    } catch { return null; }
}

function clearPending() {
    localStorage.removeItem(STORAGE_KEY);
    log('Pending cleared.');
}

/* ─── Mobile detection ───────────────────────────────────────── */

/**
 * Returns true when the current device looks like a mobile/tablet.
 * Covers:
 *   - iOS (iPhone / iPod / iPad, including iPad in desktop-mode which
 *     reports a Mac UA but exposes touch points)
 *   - Android phones & tablets
 *   - Other common mobile UA strings
 */
function isMobileDevice() {
    const ua = navigator.userAgent;
    if (/iPhone|iPod|Android|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
    // iPad — both native UA and desktop-mode (reports Macintosh but has touch)
    if (/iPad/i.test(ua)) return true;
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
}

/**
 * Central gate: returns true when the extension should actually do work.
 * Respects both the enabled toggle and the mobileOnly toggle.
 */
function isOperational() {
    const s = getSettings();
    if (!s.enabled) return false;
    if (s.mobileOnly && !isMobileDevice()) return false;
    return true;
}

/* ─── Proxy health check ──────────────────────────────────────── */

async function checkProxy() {
    try {
        const resp = await fetch('/_slproxy/health', { credentials: 'include' });
        proxyActive = resp.ok && (await resp.json()).ok === true;
    } catch {
        proxyActive = false;
    }
    log('Proxy active:', proxyActive);
    updateProxyStatus();
    return proxyActive;
}

/* ─── Fetch interceptor ───────────────────────────────────────── */

/**
 * Wraps window.fetch to observe generate responses.
 * Does NOT change any URLs — the proxy is already transparent.
 * Reads the X-SL-Stream-Id header from generate responses and stores
 * it in localStorage so recovery can target the exact stream.
 */
function installFetchInterceptor() {
    if (fetchInterceptorActive) return;
    originalFetch = window.fetch.bind(window);
    window.fetch = async function slObserve(url, options) {
        const urlStr = typeof url === 'string' ? url : String(url);
        const isGenerate = /\/api\/.*\/generate\/?$/.test(urlStr);

        if (isGenerate && isOperational() && proxyActive) {
            // Pre-generate the stream ID so we save it BEFORE the network round-trip.
            // If the user locks their phone during prompt processing, the fetch promise
            // might never resolve, so we must save our state immediately.
            const streamId = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 10);
            
            options = options || {};
            options.headers = options.headers || {};
            if (options.headers instanceof Headers) {
                options.headers.set('X-SL-Stream-Id', streamId);
            } else if (Array.isArray(options.headers)) {
                options.headers.push(['X-SL-Stream-Id', streamId]);
            } else {
                options.headers['X-SL-Stream-Id'] = streamId;
            }

            const chatId = SillyTavern.getContext().getCurrentChatId?.() ?? '';
            savePending(chatId, streamId);
        }

        // Let the request proceed normally
        return await originalFetch(url, options);
    };
    fetchInterceptorActive = true;
    log('Fetch interceptor installed.');
}

function removeFetchInterceptor() {
    if (!fetchInterceptorActive || !originalFetch) return;
    window.fetch = originalFetch;
    originalFetch = null;
    fetchInterceptorActive = false;
    log('Fetch interceptor removed.');
}

/* ─── Recovery ────────────────────────────────────────────────── */

async function attemptRecovery() {
    const pending = loadPending();
    if (!pending) return;

    recovering = true;
    showBanner('Checking for response\u2026');
    log('Recovery started for stream:', pending.streamId);

    if (!proxyActive) {
        // Proxy not reachable — try a direct reload as a best-effort fallback.
        await directReloadFallback();
        return;
    }

    // Poll the proxy's reconnect endpoint.
    // The endpoint long-polls (holds the connection open) while the stream is
    // still in progress, so we get notified the moment ST finishes.
    // We use a 35 s client-side abort to protect against idle connections
    // and retry automatically until the page is hidden or we time out.
    let attempts = 0;
    while (document.visibilityState === 'visible' && attempts < 72) { // max ~6 min
        try {
            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 35_000);
            const resp  = await fetch(
                `/_slproxy/reconnect/${pending.streamId}`,
                { credentials: 'include', signal: ctrl.signal },
            );
            clearTimeout(timer);
            const data = await resp.json();

            if (data.complete) {
                // Proxy has finished buffering — ST saved the chat. Reload.
                clearPending();
                hideBanner();
                recovering = false;
                const ctx = SillyTavern.getContext();

                // Provide the text back to the client to either copy or insert
                // because ST's backend does not auto-save interrupted SSE streams.
                let recoveredViaModal = false;
                if (data.text) {
                    if (getSettings().autoInsert) {
                        await insertRecoveredText(data.text);
                    } else {
                        await showRecoveryModal(data.text);
                    }
                    recoveredViaModal = true;
                }

                await ctx.reloadCurrentChat();
                ctx.scrollChatToBottom();
                
                const last = ctx.chat?.[ctx.chat.length - 1];
                if (recoveredViaModal || (last && !last.is_user)) {
                    toastr.success('Response recovered!', 'Stream Lazarus', { timeOut: 3000 });
                } else {
                    toastr.warning('Generation ended, but no text could be extracted.', 'Stream Lazarus', { timeOut: 5000 });
                }
                log('Recovery complete.');
                return;
            }

            if (!data.found) {
                // Stream entry expired or proxy restarted.  Try a direct reload
                // in case ST already saved the response anyway.
                log('Stream not found in proxy — trying direct reload.');
                await directReloadFallback();
                return;
            }

            // data.complete === false: stream still in progress (or long-poll
            // timed out server-side). Update the banner and go around again.
            updateBanner('Generation in progress\u2026 waiting for response');

        } catch (e) {
            if (e.name !== 'AbortError') {
                log('Reconnect error:', e.message);
                await sleep(5_000);
            }
            // AbortError = our 35 s client timeout: just retry immediately.
        }
        attempts++;
    }

    // Page was hidden again or we exceeded the attempt limit.
    hideBanner();
    recovering = false;
    log('Recovery loop exited — page hidden or timed out.');
}

/** Fallback when the proxy stream entry is gone: reload and check. */
async function directReloadFallback() {
    hideBanner();
    recovering = false;
    try {
        const ctx = SillyTavern.getContext();
        await ctx.reloadCurrentChat();
        const last = ctx.chat?.[ctx.chat.length - 1];
        if (last && !last.is_user) {
            clearPending();
            ctx.scrollChatToBottom();
            toastr.success('Response recovered!', 'Stream Lazarus', { timeOut: 3000 });
        }
    } catch (e) {
        log('Direct reload failed:', e.message);
    }
}

/* ─── Visibility handler ──────────────────────────────────────── */

let visibilityCheckTimeout = null;

async function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    if (!isOperational()) return;
    if (recovering) return;

    // Debounce to prevent multiple triggers from focus/pageshow/visibilitychange firing together
    // and give TouchID/FaceID unlock animations a moment to settle.
    if (visibilityCheckTimeout) clearTimeout(visibilityCheckTimeout);
    visibilityCheckTimeout = setTimeout(async () => {
        const pending = loadPending();
        if (!pending) return;

        log('Page visible — pending recovery present, starting…');
        toastr.info('Checking for response\u2026', 'Stream Lazarus', { timeOut: 2000 });
        await attemptRecovery();
    }, 600);
}

/* ─── ST event handlers ───────────────────────────────────────── */

function onGenerationComplete() {
    // Normal completion: the response was rendered in the UI.
    // Clear localStorage so no recovery is triggered on the next visibility change.
    clearPending();
}

function onGenerationStopped() {
    clearPending();
}

function onChatChanged() {
    clearPending();
    recovering = false;
    hideBanner();
    // Check if we have a pending for this newly-loaded chat (page reload path).
    checkPendingOnChatLoad();
}

function checkPendingOnChatLoad() {
    if (!isOperational()) return;
    const pending = loadPending();
    if (!pending) return;
    const ctx = SillyTavern.getContext();
    const chatId = ctx.getCurrentChatId?.();
    if (!chatId || chatId !== pending.chatId) return;
    // Last message is already an AI reply — ST saved it; nothing to do.
    const last = ctx.chat?.[ctx.chat.length - 1];
    if (last && !last.is_user) { clearPending(); return; }
    // Page reloaded mid-generation — attempt recovery after a short delay.
    log('Chat loaded with pending recovery — scheduling…');
    setTimeout(async () => {
        if (!loadPending()) return; // already cleared
        toastr.info('Checking for missed response\u2026', 'Stream Lazarus', { timeOut: 3000 });
        await attemptRecovery();
    }, 1500);
}

/* ─── Event registration ──────────────────────────────────────── */

function registerEvents() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onGenerationComplete);
    eventSource.on(event_types.GENERATION_STOPPED,         onGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED,               onChatChanged);
}

function unregisterEvents() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onGenerationComplete);
    eventSource.removeListener(event_types.GENERATION_STOPPED,         onGenerationStopped);
    eventSource.removeListener(event_types.CHAT_CHANGED,               onChatChanged);
}

/* ─── UI: Status banner ───────────────────────────────────────── */

function createBanner() {
    if (document.getElementById('sl-status-banner')) return;
    const b = document.createElement('div');
    b.id = 'sl-status-banner';
    b.innerHTML = '<i class="fa-solid fa-rotate-right sl-banner-icon"></i>'
                + '<span id="sl-banner-text"></span>';
    document.body.appendChild(b);
}

function showBanner(text) {
    const b = document.getElementById('sl-status-banner');
    const t = document.getElementById('sl-banner-text');
    if (b && t) { t.textContent = text; b.classList.add('sl-visible'); }
}

function updateBanner(text) {
    const t = document.getElementById('sl-banner-text');
    if (t) t.textContent = text;
}

function hideBanner() {
    document.getElementById('sl-status-banner')?.classList.remove('sl-visible');
}

/* ─── Settings panel ──────────────────────────────────────────── */

async function renderSettingsPanel() {
    const html = await SillyTavern.getContext()
        .renderExtensionTemplateAsync('third-party/STreamLazarus', 'settings');
    $('#extensions_settings2').append(html);
    bindSettingsControls();
}

function bindSettingsControls() {
    const settings = getSettings();
    updateProxyStatus();

    document.getElementById('sl_proxy_recheck')
        ?.addEventListener('click', async () => {
            const btn = document.getElementById('sl_proxy_recheck');
            if (btn) btn.disabled = true;
            await checkProxy();
            if (!fetchInterceptorActive && proxyActive && isOperational()) installFetchInterceptor();
            if (btn) btn.disabled = false;
        });

    $('#sl_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () {
            const ctx = SillyTavern.getContext();
            ctx.extensionSettings[MODULE_NAME] ??= {};
            ctx.extensionSettings[MODULE_NAME].enabled = !!this.checked;
            saveSettings();
        });

    $('#sl_auto_insert')
        .prop('checked', settings.autoInsert)
        .on('change', function () {
            const ctx = SillyTavern.getContext();
            ctx.extensionSettings[MODULE_NAME] ??= {};
            ctx.extensionSettings[MODULE_NAME].autoInsert = !!this.checked;
            saveSettings();
        });

    $('#sl_mobile_only')
        .prop('checked', settings.mobileOnly)
        .on('change', function () {
            const ctx = SillyTavern.getContext();
            ctx.extensionSettings[MODULE_NAME] ??= {};
            ctx.extensionSettings[MODULE_NAME].mobileOnly = !!this.checked;
            saveSettings();
            // Re-install or remove the fetch interceptor based on new setting.
            if (isOperational() && proxyActive) {
                installFetchInterceptor();
            } else {
                removeFetchInterceptor();
            }
        });
}

function updateProxyStatus() {
    const el = document.getElementById('sl_proxy_status');
    if (!el) return;
    if (proxyActive) {
        el.textContent = '\u2713 Connected';
        el.className   = 'sl-plugin-status sl-plugin-ok';
    } else {
        el.textContent = '\u2717 Not detected';
        el.className   = 'sl-plugin-status sl-plugin-missing';
    }
}

/* ─── Recovery: shared insert logic ──────────────────────────── */

/**
 * Inserts recovered text into the chat programmatically.
 * Shared by both the modal's Insert button and auto-insert mode.
 */
async function insertRecoveredText(text) {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat) return;

    const lastMsg = ctx.chat[ctx.chat.length - 1];
    if (!lastMsg || lastMsg.is_user) {
        let charName = 'AI';
        if (ctx.characterId && ctx.characters?.[ctx.characterId]) {
            charName = ctx.characters[ctx.characterId].name;
        } else {
            const lastAiMsg = [...ctx.chat].reverse().find(m => !m.is_user);
            if (lastAiMsg && lastAiMsg.name) charName = lastAiMsg.name;
        }
        ctx.chat.push({
            name: charName,
            is_user: false,
            is_name: true,
            send_date: Date.now(),
            mes: text,
            swipes: [text],
            swipe_id: 0,
            extra: {}
        });
    } else {
        lastMsg.mes = text;
        if (Array.isArray(lastMsg.swipes)) {
            if (lastMsg.swipes.length > 0) {
                lastMsg.swipes[lastMsg.swipe_id || 0] = text;
            } else {
                lastMsg.swipes.push(text);
                lastMsg.swipe_id = 0;
            }
        } else {
            lastMsg.swipes = [text];
            lastMsg.swipe_id = 0;
        }
    }
    await forceSaveChat();
}

/* ─── Recovery Modal ──────────────────────────────────────────── */

function showRecoveryModal(text) {
    return new Promise(resolve => {
        document.getElementById('sl-recovery-modal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'sl-recovery-modal';
        modal.innerHTML = `
            <div class="sl-modal-backdrop">
                <div class="sl-modal-box">
                    <div class="sl-modal-header">
                        <i class="fa-solid fa-truck-medical"></i>
                        <span>Response Recovered</span>
                    </div>
                    <p class="sl-modal-hint">Your connection dropped, but the server finished generating. What would you like to do with the recovered text?</p>
                    <div class="sl-modal-body">${escapeHTML(text)}</div>
                    <div class="sl-modal-footer">
                        <button class="sl-modal-btn sl-modal-copy" style="margin-right: auto;">
                            <i class="fa-solid fa-copy"></i> Copy Text
                        </button>
                        <button class="sl-modal-btn sl-modal-insert" style="background: rgba(76, 175, 80, 0.2); color: #4caf50;">
                            <i class="fa-solid fa-arrow-down-to-line"></i> Insert to Chat
                        </button>
                        <button class="sl-modal-btn sl-modal-close">
                            Discard
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.sl-modal-copy').addEventListener('click', async () => {
            await navigator.clipboard.writeText(text);
            toastr.success('Copied to clipboard!');
        });

        modal.querySelector('.sl-modal-insert').addEventListener('click', async () => {
            await insertRecoveredText(text);
            modal.remove();
            resolve(true);
        });

        modal.querySelector('.sl-modal-close').addEventListener('click', () => {
            modal.remove();
            resolve(false);
        });
    });
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

/* ─── Lifecycle hooks ─────────────────────────────────────────── */

export function onActivate() { log('Extension activated.'); }

export function onDisable() {
    log('Extension disabled — cleaning up.');
    removeFetchInterceptor();
    unregisterEvents();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onVisibilityChange);
    window.removeEventListener('pageshow', onVisibilityChange);
    hideBanner();
    recovering = false;
}

/* ─── Entry point ─────────────────────────────────────────────── */

(async function init() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, async () => {
        log('Initialising\u2026');
        getSettings();
        await renderSettingsPanel();
        registerEvents();
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('focus', onVisibilityChange);
        window.addEventListener('pageshow', onVisibilityChange);
        createBanner();
        const active = await checkProxy();
        if (active && isOperational()) installFetchInterceptor();
        updateProxyStatus();
        log('Ready. Proxy:', proxyActive);
    });
})();

/* ─── Utilities ───────────────────────────────────────────────── */

async function forceSaveChat() {
    const ctx = SillyTavern.getContext();
    
    if (typeof window.saveChat === 'function') {
        await window.saveChat();
        return;
    }
    if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
        return;
    }

    const chatId = ctx.getCurrentChatId?.() ?? ctx.chatId;
    if (!chatId) return;

    try {
        await fetch('/api/chats/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': window['csrf_token'] || ctx.csrfToken || '',
            },
            body: JSON.stringify({ chat: chatId, data: ctx.chat })
        });
        log('Chat saved via fallback API.');
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to save chat via API fallback', e);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(...a) { console.debug(LOG_PREFIX, ...a); }

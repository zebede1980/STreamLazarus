/**
 * Stream Lazarus — SillyTavern Mobile Stream Recovery Extension
 *
 * When iOS suspends the browser mid-generation (killing the SSE stream),
 * this extension detects the disconnect and automatically recovers the
 * completed response from the server-side chat file when you return to the page.
 *
 * Architecture:
 *  1. Track whether a generation is in progress via ST event system.
 *  2. Listen for `visibilitychange` — fires when you unlock/switch back to the page.
 *  3. If a generation was in progress: wait briefly, then reload the chat from the server.
 *  4. If the backend is still generating: poll periodically until the response arrives.
 */

const MODULE_NAME = 'stream_lazarus';
const LOG_PREFIX = '[StreamLazarus]';
/** localStorage key for persisting pending-recovery state across full page reloads */
const STORAGE_KEY = 'sl_pending_recovery';
/** Max age (ms) before a persisted pending state is considered stale */
const PENDING_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/* ─── Default settings ────────────────────────────────────────── */

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    /** ms to wait after page becomes visible before attempting recovery */
    recoveryDelay: 2000,
    pollingEnabled: true,
    /** seconds between each re-check */
    pollingIntervalSec: 15,
    /** give up after this many poll attempts */
    maxPollingAttempts: 8,
});

/* ─── Module state ────────────────────────────────────────────── */

/** True while the AI is generating and the UI hasn't received the completed message */
let isGenerating = false;
/** Cached last-message count at generation start — used to detect new content on reload */
let chatLengthAtStart = 0;
/** Active polling timer ID */
let pollTimer = null;
/** Current poll attempt counter */
let pollAttempts = 0;
/** Whether a recovery cycle is currently running (prevents overlapping cycles) */
let recovering = false;
/** Set when visibilitychange→hidden fires while isGenerating is true.
 *  This is set BEFORE iOS freezes JS, so when the page resumes and deferred
 *  callbacks fire (e.g. ST's stream error handler → GENERATION_ENDED), we can
 *  tell onGenerationEnded not to clear isGenerating underneath the recovery logic.
 *  This is more reliable than awaitingRecovery (which was set too late, inside
 *  the visible handler, after deferred work had already run). */
let pageWasHiddenDuringGeneration = false;
/** True while we are inside our own reloadCurrentChat() call — prevents the
 *  CHARACTER_MESSAGE_RENDERED event (fired by ST when re-rendering messages) from
 *  being mistaken for a natural generation completion and clearing our state early. */
let isReloading = false;

/* ─── Settings helpers ────────────────────────────────────────── */

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = {};
    }
    // Merge stored settings with defaults so new keys appear after updates
    context.extensionSettings[MODULE_NAME] = SillyTavern.libs.lodash.merge(
        structuredClone(DEFAULT_SETTINGS),
        context.extensionSettings[MODULE_NAME],
    );
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

/* ─── localStorage persistence (survives full page kill/reload) ───
 *
 * When iOS kills the tab entirely (not just suspends it), all JS state is wiped.
 * We persist the "generation in progress" flag to localStorage so that when ST
 * reloads and fires CHAT_CHANGED, we can re-arm isGenerating and attempt recovery.
 */

function persistPending() {
    const context = SillyTavern.getContext();
    const chatId = context.getCurrentChatId?.();
    if (!chatId) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            chatId,
            chatLengthAtStart,
            timestamp: Date.now(),
        }));
        log('Pending recovery persisted for chat:', chatId);
    } catch (e) {
        console.warn(LOG_PREFIX, 'Could not persist pending state:', e);
    }
}

function clearPending() {
    localStorage.removeItem(STORAGE_KEY);
    log('Pending recovery cleared.');
}

/**
 * Called on every CHAT_CHANGED (including the initial auto-load on page reload).
 * If localStorage has a pending recovery for this chat and the last message is still
 * from the user (AI never responded), re-arms isGenerating and triggers recovery.
 */
function checkPendingOnChatLoad() {
    if (!getSettings().enabled) return;

    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;

    let pending;
    try {
        pending = JSON.parse(stored);
    } catch {
        clearPending();
        return;
    }

    const context = SillyTavern.getContext();
    const currentChatId = context.getCurrentChatId?.();

    if (!currentChatId || pending.chatId !== currentChatId) {
        log('Pending recovery is for a different chat — skipping.');
        return; // Don't clear: user may return to the original chat
    }

    if (Date.now() - pending.timestamp > PENDING_EXPIRY_MS) {
        log('Pending recovery expired (> 30 min) — discarding.');
        clearPending();
        return;
    }

    // If the last message is already an AI reply, the backend finished and
    // ST auto-loaded it. Nothing to do.
    const chat = context.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;
    const lastMessage = chat[chat.length - 1];
    if (lastMessage && !lastMessage.is_user) {
        log('Chat reloaded with AI response already present — clearing pending.');
        clearPending();
        return;
    }

    // Last message is from the user — AI never responded. Arm recovery.
    log('Page reloaded mid-generation. Re-arming recovery for chat:', currentChatId);
    chatLengthAtStart = pending.chatLengthAtStart;
    isGenerating = true;

    // Short delay: let ST finish rendering the chat before we trigger a reload.
    setTimeout(async () => {
        if (!isGenerating) return;
        toastr.info('Checking for missed response…', 'Stream Lazarus', { timeOut: 3000 });
        await attemptRecovery();
    }, 1500);
}

/* ─── Generation state tracking ──────────────────────────────────
 *
 * Normal flow:
 *   GENERATION_STARTED → tokens stream → CHARACTER_MESSAGE_RENDERED → GENERATION_ENDED
 *
 * iOS disconnect flow:
 *   GENERATION_STARTED → (iOS kills connection) → GENERATION_ENDED (error path)
 *   CHARACTER_MESSAGE_RENDERED never fires.
 *
 * We set isGenerating=true on START and clear it on MESSAGE_RENDERED or STOPPED.
 * A recovery is triggered when the page becomes visible while isGenerating is still true.
 */

function onMessageSent() {
    // Arm as early as possible — MESSAGE_SENT fires the instant the user taps Send,
    // before any network round-trip to the AI API. This covers the race condition
    // where the user locks the phone in the seconds between Send and the first token
    // arriving (which is when GENERATION_STARTED would otherwise fire).
    const context = SillyTavern.getContext();
    isGenerating = true;
    chatLengthAtStart = context.chat?.length ?? 0;
    log('User message sent — recovery armed. Chat length:', chatLengthAtStart);
    // Persist to localStorage so recovery survives a full iOS page kill/reload.
    persistPending();
}

function onGenerationStarted(type, _params, isDryRun) {
    // Ignore background/dry-run generations (e.g. Summarize, Objective extensions).
    if (isDryRun || type === 'quiet' || type === 'impersonate') {
        log(`Ignoring generation start (type=${type}, isDryRun=${isDryRun}).`);
        return;
    }
    // Refine chatLengthAtStart — by GENERATION_STARTED, ST has finished pre-generation
    // processing, making this the most accurate baseline for the new-content check.
    // isGenerating was already set by onMessageSent; set it again as a safety net
    // for group chat auto-replies (which don't always emit MESSAGE_SENT first).
    const context = SillyTavern.getContext();
    isGenerating = true;
    chatLengthAtStart = context.chat?.length ?? 0;
    log('Generation started (refined). Chat length:', chatLengthAtStart);
}

function onGenerationEnded() {
    // If the page is visible and we are NOT in a recovery window, generation finished
    // (or errored) while the user was actively watching — clear the flag.
    // Do NOT clear if awaitingRecovery or recovering is set: this means the user
    // just returned to the page and iOS is resuming deferred async work (the stream
    // reader error handler from when the connection was killed). Clearing here would
    // cause onVisibilityChange to think the stream recovered on its own and bail out.
    if (document.visibilityState === 'visible' && !pageWasHiddenDuringGeneration && !recovering) {
        if (isGenerating) {
            log('Generation ended while page visible — clearing armed flag.');
            isGenerating = false;
            clearPending();
        }
        stopPolling();
    }
}

function onGenerationComplete() {
    // CHARACTER_MESSAGE_RENDERED also fires when ST re-renders messages during our
    // own reloadCurrentChat() call. Ignore those — we handle the outcome in reloadAndCheck().
    if (isReloading) return;
    if (!isGenerating) return;
    log('Generation completed normally — no recovery needed.');
    isGenerating = false;
    recovering = false;
    pageWasHiddenDuringGeneration = false;
    clearPending();
    stopPolling();
    hideSyncButton();
    hideBanner();
}

function onGenerationStopped() {
    log('Generation stopped by user.');
    isGenerating = false;
    pageWasHiddenDuringGeneration = false;
    clearPending();
    stopPolling();
    hideSyncButton();
    hideBanner();
}

function onChatChanged() {
    log('Chat changed — resetting state.');
    isGenerating = false;
    pageWasHiddenDuringGeneration = false;
    recovering = false;
    stopPolling();
    hideSyncButton();
    hideBanner();
    // Check localStorage: if this is the chat we were generating in (either a
    // page-reload auto-load or the user navigating back), re-arm recovery.
    checkPendingOnChatLoad();
}

/* ─── Recovery logic ──────────────────────────────────────────── */

async function attemptRecovery() {
    if (recovering) {
        log('Recovery already in progress — skipping.');
        return;
    }
    if (!isGenerating) {
        log('No generation in progress — nothing to recover.');
        return;
    }
    if (!getSettings().enabled) {
        return;
    }

    recovering = true;
    log('Starting recovery cycle...');

    try {
        showBanner('Checking for response…');
        showSyncButton(true);

        const settings = getSettings();
        const newContent = await reloadAndCheck();

        if (newContent) {
            log('Response recovered on first attempt.');
            onRecoverySuccess();
            return;
        }

        // No new content yet — backend may still be generating.
        if (settings.pollingEnabled) {
            log('No new content yet. Starting polling fallback...');
            startPolling();
        } else {
            log('Polling disabled. Recovery attempt finished.');
            onRecoveryFailed();
        }
    } catch (err) {
        console.error(LOG_PREFIX, 'Error during recovery:', err);
        onRecoveryFailed();
    }
}

/**
 * Reloads the current chat from the server and checks whether new content arrived.
 * @returns {Promise<boolean>} true if the server has content that wasn't in the UI.
 */
async function reloadAndCheck() {
    const context = SillyTavern.getContext();
    const chatLengthBefore = context.chat?.length ?? 0;

    // Guard: prevent CHARACTER_MESSAGE_RENDERED (fired during reload) from
    // prematurely clearing isGenerating and stopping the polling loop.
    isReloading = true;
    try {
        await context.reloadCurrentChat();
    } finally {
        isReloading = false;
    }

    // After reload, re-read context (reference may be the same array but refreshed)
    const chatLengthAfter = SillyTavern.getContext().chat?.length ?? 0;
    const lastMessage = SillyTavern.getContext().chat?.[chatLengthAfter - 1];

    const hasNewAiMessage = chatLengthAfter > chatLengthAtStart && lastMessage && !lastMessage.is_user;

    log(`Reload check: before=${chatLengthBefore}, after=${chatLengthAfter}, hasNewAiMessage=${hasNewAiMessage}`);
    return hasNewAiMessage;
}

/* ─── Polling fallback ────────────────────────────────────────── */

function startPolling() {
    const settings = getSettings();
    pollAttempts = 0;
    const intervalMs = settings.pollingIntervalSec * 1000;

    log(`Polling every ${settings.pollingIntervalSec}s, max ${settings.maxPollingAttempts} attempts.`);
    updateBanner(`Still waiting for response… (checking every ${settings.pollingIntervalSec}s)`);

    pollTimer = setInterval(async () => {
        if (!isGenerating) {
            // Generation finished via the normal event path while we were polling
            stopPolling();
            return;
        }

        pollAttempts++;
        log(`Poll attempt ${pollAttempts}/${settings.maxPollingAttempts}`);
        updateBanner(`Checking for response… (attempt ${pollAttempts}/${settings.maxPollingAttempts})`);

        try {
            const newContent = await reloadAndCheck();
            if (newContent) {
                stopPolling();
                onRecoverySuccess();
                return;
            }
        } catch (err) {
            console.error(LOG_PREFIX, 'Poll reload error:', err);
        }

        if (pollAttempts >= settings.maxPollingAttempts) {
            log('Max poll attempts reached. Giving up.');
            stopPolling();
            onRecoveryFailed();
        }
    }, intervalMs);
}

function stopPolling() {
    if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
        log('Polling stopped.');
    }
    pollAttempts = 0;
}

/* ─── Recovery outcome ────────────────────────────────────────── */

function onRecoverySuccess() {
    isGenerating = false;
    recovering = false;
    pageWasHiddenDuringGeneration = false;
    clearPending();
    stopPolling();
    hideBanner();
    hideSyncButton();
    SillyTavern.getContext().scrollChatToBottom();
    toastr.success('Response recovered!', 'Stream Lazarus', { timeOut: 3000 });
    log('Recovery successful.');
}

function onRecoveryFailed() {
    // Clear isGenerating so that subsequent visibilitychange events (notification
    // banners, briefly switching apps, iOS keyboard interactions) do NOT trigger
    // another spurious reloadCurrentChat() and cause UI flicker.
    // The manual sync button is always available for an on-demand retry.
    isGenerating = false;
    recovering = false;
    pageWasHiddenDuringGeneration = false;
    clearPending();
    hideBanner();
    hideSyncButton(); // hide spinning state
    showSyncButton(false); // show idle state for manual retry

    const settings = getSettings();
    const totalWaitSec = settings.pollingEnabled
        ? settings.pollingIntervalSec * settings.maxPollingAttempts
        : Math.round(settings.recoveryDelay / 1000);

    toastr.warning(
        `No response found after ${totalWaitSec}s. Tap the sync button to try again.`,
        'Stream Lazarus',
        { timeOut: 6000 },
    );
    log('Recovery failed — manual sync available.');
}

/* ─── Page visibility handler ─────────────────────────────────── */

async function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
        // Page going into background. If a generation is in progress, arm the flag NOW
        // (before JS is frozen by iOS) so that when we resume and deferred async work
        // fires (ST's stream error handler, GENERATION_ENDED, etc.), onGenerationEnded
        // sees pageWasHiddenDuringGeneration=true and does not clear isGenerating.
        if (isGenerating) {
            pageWasHiddenDuringGeneration = true;
            log('Page hidden during generation — protection flag armed.');
        }
        return;
    }

    // Page became visible.
    if (!getSettings().enabled) return;
    if (!isGenerating) return;

    log('Page became visible during generation — scheduling recovery...');
    toastr.info('Checking for missed response…', 'Stream Lazarus', { timeOut: 2500 });

    const delay = getSettings().recoveryDelay;
    // Brief wait: lets any still-live stream settle (or fail cleanly) before we reload.
    await sleep(delay);

    // After the delay, check again. The only way isGenerating is now false is if
    // CHARACTER_MESSAGE_RENDERED or GENERATION_STOPPED fired (genuine success/cancel).
    // GENERATION_ENDED alone cannot clear it thanks to pageWasHiddenDuringGeneration.
    if (!isGenerating) {
        log('Stream genuinely recovered during delay. No action needed.');
        pageWasHiddenDuringGeneration = false;
        return;
    }

    await attemptRecovery();
}

/* ─── UI: Floating sync button ────────────────────────────────── */

function createSyncButton() {
    if (document.getElementById('sl-sync-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'sl-sync-btn';
    btn.title = 'Sync response (Stream Lazarus)';
    btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';
    btn.addEventListener('click', onManualSync);
    document.body.appendChild(btn);
}

function showSyncButton(spinning = false) {
    const btn = document.getElementById('sl-sync-btn');
    if (!btn) return;
    btn.classList.add('sl-visible');
    btn.classList.toggle('sl-spinning', spinning);
}

function hideSyncButton() {
    const btn = document.getElementById('sl-sync-btn');
    if (!btn) return;
    btn.classList.remove('sl-visible', 'sl-spinning');
}

async function onManualSync() {
    if (recovering) return;
    log('Manual sync triggered manually.');
    // Re-arm isGenerating so attemptRecovery() proceeds even after a failed recovery
    // cycle cleared it. Reset chatLengthAtStart to current length so the new-content
    // check compares against what's on screen right now.
    isGenerating = true;
    chatLengthAtStart = SillyTavern.getContext().chat?.length ?? 0;
    await attemptRecovery();
}

/* ─── UI: Status banner ───────────────────────────────────────── */

function createBanner() {
    if (document.getElementById('sl-status-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'sl-status-banner';
    banner.innerHTML = `
        <i class="fa-solid fa-rotate-right sl-banner-icon"></i>
        <span id="sl-banner-text"></span>
    `;
    document.body.appendChild(banner);
}

function showBanner(text) {
    const banner = document.getElementById('sl-status-banner');
    const label = document.getElementById('sl-banner-text');
    if (!banner || !label) return;
    label.textContent = text;
    banner.classList.add('sl-visible');
}

function updateBanner(text) {
    const label = document.getElementById('sl-banner-text');
    if (label) label.textContent = text;
}

function hideBanner() {
    const banner = document.getElementById('sl-status-banner');
    if (banner) banner.classList.remove('sl-visible');
}

/* ─── Settings panel rendering ────────────────────────────────── */

async function renderSettingsPanel() {
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    const html = await renderExtensionTemplateAsync('third-party/STreamLazarus', 'settings');
    $('#extensions_settings2').append(html);
    bindSettingsControls();
}

function bindSettingsControls() {
    const settings = getSettings();

    /* Enabled toggle */
    $('#sl_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () {
            getSettings().enabled = !!this.checked;
            saveSettings();
        });

    /* Recovery delay slider */
    const delaySlider = document.getElementById('sl_recovery_delay');
    const delayValue = document.getElementById('sl_recovery_delay_value');
    if (delaySlider && delayValue) {
        delaySlider.value = String(settings.recoveryDelay);
        delayValue.textContent = formatMs(settings.recoveryDelay);
        delaySlider.addEventListener('input', function () {
            const v = Number(this.value);
            delayValue.textContent = formatMs(v);
            getSettings().recoveryDelay = v;
            saveSettings();
        });
    }

    /* Polling enabled toggle */
    $('#sl_polling_enabled')
        .prop('checked', settings.pollingEnabled)
        .on('change', function () {
            getSettings().pollingEnabled = !!this.checked;
            saveSettings();
        });

    /* Polling interval slider */
    const intervalSlider = document.getElementById('sl_polling_interval');
    const intervalValue = document.getElementById('sl_polling_interval_value');
    if (intervalSlider && intervalValue) {
        intervalSlider.value = String(settings.pollingIntervalSec);
        intervalValue.textContent = `${settings.pollingIntervalSec}s`;
        intervalSlider.addEventListener('input', function () {
            const v = Number(this.value);
            intervalValue.textContent = `${v}s`;
            getSettings().pollingIntervalSec = v;
            saveSettings();
        });
    }

    /* Max attempts slider */
    const attemptsSlider = document.getElementById('sl_max_polling_attempts');
    const attemptsValue = document.getElementById('sl_max_polling_attempts_value');
    if (attemptsSlider && attemptsValue) {
        attemptsSlider.value = String(settings.maxPollingAttempts);
        const updateAttemptLabel = (v) => {
            const settings_ = getSettings();
            const totalSec = v * settings_.pollingIntervalSec;
            attemptsValue.textContent = `${v} (max ${formatSeconds(totalSec)} wait)`;
        };
        updateAttemptLabel(settings.maxPollingAttempts);
        attemptsSlider.addEventListener('input', function () {
            const v = Number(this.value);
            getSettings().maxPollingAttempts = v;
            updateAttemptLabel(v);
            saveSettings();
        });
    }
}

/* ─── Event registration ──────────────────────────────────────── */

function registerEvents() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Arm immediately when user hits Send — before the network round-trip to the API.
    // This catches the race condition where the phone is locked in the first few seconds
    // after Send but before the first streaming token arrives.
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);

    // Refine chatLengthAtStart once ST has finished pre-generation processing.
    // Also arms isGenerating for group auto-replies that skip MESSAGE_SENT.
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    // Clear the flag on a successful response rendered in the UI.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onGenerationComplete);

    // Clear when generation ends while the user is actively watching
    // (covers API errors, empty responses, etc. that don't trigger MESSAGE_RENDERED).
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    // Clear on user cancel.
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    // Clear on chat switch.
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
}

function unregisterEvents() {
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.removeListener(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onGenerationComplete);
    eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
}

/* ─── Lifecycle hooks (exported for manifest.json hooks config) ── */

export function onActivate() {
    log('Extension activated.');
}

export function onDisable() {
    log('Extension disabled — cleaning up.');
    unregisterEvents();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    stopPolling();
    hideSyncButton();
    hideBanner();
    isGenerating = false;
    recovering = false;
    awaitingRecovery = false;
}

/* ─── Entry point ─────────────────────────────────────────────── */

(async function init() {
    const { eventSource, event_types } = SillyTavern.getContext();

    eventSource.on(event_types.APP_READY, async () => {
        log('APP_READY — initialising...');

        // Ensure settings exist / are migrated
        getSettings();

        // Render settings panel
        await renderSettingsPanel();

        // Wire generation tracking
        registerEvents();

        // Wire visibility watcher
        document.addEventListener('visibilitychange', onVisibilityChange);

        // Create persistent DOM elements
        createSyncButton();
        createBanner();

        log('Ready. Enabled:', getSettings().enabled);
    });
})();

/* ─── Utilities ───────────────────────────────────────────────── */

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMs(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatSeconds(sec) {
    return sec >= 60 ? `${Math.round(sec / 60)}m` : `${sec}s`;
}

function log(...args) {
    console.debug(LOG_PREFIX, ...args);
}

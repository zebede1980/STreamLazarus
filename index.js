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
/** Set as soon as visibilitychange decides recovery is needed, before the sleep delay.
 *  Prevents onGenerationEnded from clearing isGenerating during the recovery window
 *  when iOS resumes deferred async work (stream error handlers, etc.) after unsuspending. */
let awaitingRecovery = false;
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
    if (document.visibilityState === 'visible' && !awaitingRecovery && !recovering) {
        if (isGenerating) {
            log('Generation ended while page visible — clearing armed flag.');
            isGenerating = false;
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
    awaitingRecovery = false;
    stopPolling();
    hideSyncButton();
    hideBanner();
}

function onGenerationStopped() {
    log('Generation stopped by user.');
    isGenerating = false;
    stopPolling();
    hideSyncButton();
    hideBanner();
}

function onChatChanged() {
    log('Chat changed — resetting state.');
    isGenerating = false;
    stopPolling();
    hideSyncButton();
    hideBanner();
    recovering = false;
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
    awaitingRecovery = false;
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
    awaitingRecovery = false;
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
    if (document.visibilityState !== 'visible') return;
    if (!getSettings().enabled) return;
    if (!isGenerating) return;

    // Set this BEFORE the sleep so onGenerationEnded (which may fire during the sleep
    // as iOS resumes suspended async work) does not clear isGenerating underneath us.
    awaitingRecovery = true;

    log('Page became visible during generation — scheduling recovery...');
    toastr.info('Checking for missed response…', 'Stream Lazarus', { timeOut: 2500 });

    const delay = getSettings().recoveryDelay;
    // Brief wait: lets any still-live stream settle (or fail cleanly) before we reload.
    await sleep(delay);

    awaitingRecovery = false;

    // Re-check: normal stream may have recovered on its own during the delay
    // (only trust this if isGenerating was cleared by CHARACTER_MESSAGE_RENDERED
    // or GENERATION_STOPPED, NOT by GENERATION_ENDED which can fire spuriously).
    if (!isGenerating) {
        log('Stream recovered on its own during delay. No action needed.');
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

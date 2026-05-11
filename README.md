# 🪄 Stream Lazarus
### A SillyTavern Extension for Mobile Stream Recovery

> *"It was dead. Now it isn't."*

---

When you're playing on iPhone or iPad, iOS aggressively suspends the browser the moment you lock your screen or switch apps — killing the AI's streaming response mid-sentence. **Stream Lazarus** detects the disconnect and automatically recovers the completed response from the server when you return to the page.

No manual refreshes. No lost responses. Just seamless recovery.

---

## How It Works

SillyTavern's backend **keeps generating on the server** even after your phone drops the connection. The response gets saved to the chat file on disk — it just never made it back to your screen. Stream Lazarus fetches it when you return.

```
You lock phone                    You unlock phone
      │                                  │
      ▼                                  ▼
iOS kills SSE stream         visibilitychange fires
      │                                  │
      ▼                                  ▼
Server keeps generating      Stream Lazarus waits 2s
      │                           (lets stream settle)
      ▼                                  │
Response saved to disk         reloadCurrentChat()
                                         │
                                         ▼
                              ✅ Response appears!
```

If the backend is **still generating** when you return (common with slow cloud APIs), Stream Lazarus enters a **polling loop** — re-checking the server every N seconds until the response arrives or it times out.

---

## Features

- **Automatic recovery** via the Page Visibility API — triggers the moment you return to the page
- **Polling fallback** — keeps retrying if the backend is still mid-generation
- **Manual sync button** — a floating button for on-demand recovery if polling gives up
- **Status banner** — shows recovery progress at the top of the screen
- **Non-destructive** — uses SillyTavern's own `reloadCurrentChat()`, works with solo and group chats
- **Configurable** — recovery delay, polling interval, and max attempts all adjustable
- **Zero dependencies** — pure ST extension, no Extras, no server plugins required

---

## Requirements

- SillyTavern `1.12.0` or later (release or staging branch)
- Works best with **cloud APIs** (Claude, OpenAI, Gemini, etc.) where the backend continues generating after a client disconnect
- Works with local LLMs only if the local backend is configured to not abort on disconnect

---

## Installation

### Via SillyTavern UI (recommended)

1. In SillyTavern, open **Extensions** → **Install Extension**
2. Paste this repository URL:
   ```
   https://github.com/YOUR_USERNAME/STreamLazarus
   ```
3. Click **Install** — the extension loads automatically

### Manual

1. Clone or download this repository into your SillyTavern extensions folder:
   ```
   public/scripts/extensions/third-party/STreamLazarus/
   ```
2. Reload SillyTavern
3. Enable **Stream Lazarus** in **Extensions** → **Manage Extensions**

---

## Configuration

Open **Extensions** → **Stream Lazarus** to access settings.

| Setting | Default | Description |
|---|---|---|
| **Enable Stream Lazarus** | On | Master on/off switch |
| **Initial Recovery Delay** | 2 000 ms | Time to wait after waking before reloading. Lets any still-live stream settle gracefully before intervening. |
| **Enable polling fallback** | On | If the first reload finds no response (backend still generating), keep re-checking. |
| **Polling Interval** | 15 s | How often to re-check the server during polling. |
| **Max Polling Attempts** | 8 | Give up after this many attempts. Default = 8 × 15 s = 2 min total wait. |

### Recommended starting config for a 2-minute cloud API generation

```
Recovery Delay:      2 000 ms
Polling Interval:    15 s
Max Attempts:        8        → total wait: 2 minutes
```

---

## Limitations

| Scenario | Outcome |
|---|---|
| Cloud API (Claude, OpenAI, Gemini…) | ✅ Works — backend keeps generating |
| Local LLM that aborts on disconnect | ❌ Nothing to recover — generation stops |
| Local LLM that doesn't abort (e.g. KoboldCpp with appropriate config) | ✅ Works |
| Backend still generating when you return | ✅ Polling fallback handles this |
| You manually stopped generation before locking | ✅ No spurious recovery — stop event is tracked |
| You switched to a different chat | ✅ No spurious recovery — chat change resets state |

---

## A Note on the Silence Player

The official [Silence Player](https://github.com/SillyTavern/Extension-Silence) extension plays a silent audio loop to try to keep the browser tab alive in the background. **For most iPhone usage patterns it's not recommended alongside Stream Lazarus**, for two reasons:

1. **Music interference** — iOS audio sessions are exclusive. The silent audio will compete with Spotify, Apple Music, etc. — potentially pausing or ducking your music.
2. **iOS still wins** — after ~5–15 minutes locked, or when another app claims the audio session, iOS suspends the tab anyway.

Stream Lazarus is designed to *embrace* the disconnect rather than fight it. Use it alone.

---

## Troubleshooting

**"No response found" even though the backend finished**

Check that your ST backend isn't configured to `abort on disconnect`. For KoboldCpp and most local backends, add the appropriate flag. For cloud APIs this is never an issue.

**Recovery triggers when I cancel generation intentionally**

It shouldn't — Stream Lazarus listens for `GENERATION_STOPPED` (user cancel) and clears the flag. If you see unexpected recovery, please open an issue with your ST version and API type.

**The sync button doesn't appear**

The floating sync button only appears when a recovery is in progress or has failed. It's hidden at all other times. If you want to trigger a manual sync from idle, reload the page — the chat will reload normally.

**Group chats not recovering**

Group chats use a different backend endpoint but `reloadCurrentChat()` handles both automatically. If group recovery is failing, open an issue.

---

## How It Differs from Gemini's Original Suggestion

The initial design proposed manually fetching `/api/chat/get` and patching the DOM. Stream Lazarus instead uses:

- `context.reloadCurrentChat()` — the correct internal ST API, handles both solo and group chats, applies all post-processing
- Four-event state machine (`GENERATION_STARTED`, `CHARACTER_MESSAGE_RENDERED`, `GENERATION_STOPPED`, `CHAT_CHANGED`) for precise, false-positive-free detection
- Polling loop for slow backends, rather than a single one-shot attempt

---

## License

AGPL-3.0 — see [LICENSE](LICENSE)

---

<div align="center">
  <sub>Built for the SillyTavern community · Tested on iPhone 15 Pro / iOS 18</sub>
</div>

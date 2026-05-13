# Stream Lazarus
### Mobile Stream Recovery for SillyTavern

> *"It was dead. Now it isn't."*

---

When you're on iPhone or iPad, iOS aggressively suspends the browser the moment you lock your screen or switch apps — killing the AI's streaming response mid-sentence. **Stream Lazarus** keeps the connection alive on the server side so SillyTavern never knows you left, then delivers the completed response the moment you return.

No manual refreshes. No lost responses. Just seamless recovery.

---

## Architecture

Stream Lazarus has two components that work together:

- **Proxy container** — a lightweight Docker service that sits between Nginx Proxy Manager and SillyTavern. It intercepts AI generate streams and keeps the upstream connection to ST alive even after iOS drops the browser's TCP connection. When the stream completes it buffers the response text so the client can collect it on reconnection.

- **ST client extension** — a SillyTavern extension that tags each generate request with a unique stream ID, monitors page visibility, and polls the proxy on reconnection to retrieve the finished response.

```
iPhone locks screen
       |
       v
iOS kills browser connection
       |
       v                            +-----------------------+
  NPM --> stream-lazarus proxy ---> | SillyTavern (ST)      |
              |  (keeps this        |  keeps generating     |
              |   connection alive) +-----------------------+
              |  buffers SSE text
              |
       iPhone unlocks
              |
              v
  visibilitychange fires in extension
              |
              v
  GET /_slproxy/reconnect/{streamId}
  (long-poll -- waits for completion)
              |
              v
  Response delivered -- user prompted to insert or copy
```

---

## How Recovery Works

1. Before each generate request, the extension generates a unique **stream ID** and attaches it to the request as an `X-SL-Stream-Id` header. The ID and current chat ID are saved to `localStorage` immediately — before any network round-trip.
2. The proxy intercepts the generate request, registers the stream ID, and **bridges the connection to ST**. If the iOS client disconnects, the proxy keeps the loopback connection to ST open so generation continues uninterrupted.
3. As SSE chunks arrive from ST, the proxy buffers the raw text (up to 10 MB).
4. When you unlock your phone, the extension's `visibilitychange` handler fires. It calls `/_slproxy/reconnect/{streamId}` — a **long-poll endpoint** that holds the connection open until the stream completes (up to ~6 minutes).
5. Once complete, the proxy returns the recovered text to the extension. If **auto-insert** is enabled it is inserted immediately; otherwise you are prompted to **Insert** it into the chat, **Copy** it to the clipboard, or **Discard** it.
6. After delivering the text, the extension calls `reloadCurrentChat()` to sync ST's UI with what was saved to disk.

---

## Features

- **Transparent proxy** — sits silently in front of ST; all non-generate traffic is forwarded unchanged
- **Long-poll reconnect** — holds the connection open server-side while ST is still generating, so you get the response the instant it's ready
- **30-minute expiry** — stream entries are retained for up to 30 minutes, so a longer lock is no problem
- **Recovery modal** — presents the recovered text with options to Insert, Copy, or Discard
- **Auto-insert mode** *(configurable)* — optionally bypass the prompt and insert the recovered text automatically; ideal once you are confident in the reliability
- **Status banner** — shows recovery progress at the top of the screen
- **False-positive protection** — `GENERATION_STOPPED` and `CHAT_CHANGED` events clear the pending state so intentional stops and chat switches never trigger spurious recovery
- **Direct reload fallback** — if the proxy entry has expired, the extension falls back to `reloadCurrentChat()` in case ST already saved the response to disk

---

## Requirements

- SillyTavern `1.12.0` or later
- Docker (for the proxy container)
- Nginx Proxy Manager (or equivalent reverse proxy) in front of SillyTavern
- Works best with **cloud APIs** (Claude, OpenAI, Gemini, etc.) — these continue generating server-side regardless of client disconnects
- Works with local LLMs that do **not** abort on client disconnect (e.g. KoboldCpp with `--no-abort`)

---

## Installation

### 1 — Deploy the Proxy Container

Add the `stream-lazarus` service to your existing `docker-compose.yml`. A ready-to-use snippet is provided in [`docker-compose.example.yml`](docker-compose.example.yml).

**Key steps:**

1. Copy the service block into your `docker-compose.yml`.
2. Set `ST_HOST` to your SillyTavern service name (default: `sillytavern`).
3. Ensure `stream-lazarus` is on the same Docker network as NPM and SillyTavern.
4. In Nginx Proxy Manager, edit your ST proxy host:
   - **Forward Hostname / IP:** `stream-lazarus`
   - **Forward Port:** `3000`
   - In the **Advanced** tab add:
     ```nginx
     proxy_buffering    off;
     proxy_read_timeout 300s;
     proxy_set_header   Connection '';
     ```
5. `docker compose up -d --build`

The proxy builds directly from this repository — no local clone required.

### 2 — Install the ST Extension

1. In SillyTavern, open **Extensions** → **Install Extension**
2. Paste this repository URL:
   ```
   https://github.com/zebede1980/STreamLazarus
   ```
3. Click **Install** — the extension loads automatically.

**Or manually:**

1. Clone or download this repository into your SillyTavern extensions folder:
   ```
   public/scripts/extensions/third-party/STreamLazarus/
   ```
2. Reload SillyTavern and enable **Stream Lazarus** in **Extensions** → **Manage Extensions**.

---

## Configuration

Open **Extensions** → **Stream Lazarus** to access settings.

| Setting | Default | Description |
|---|---|---|
| **Enable Stream Lazarus** | On | Master on/off switch |
| **Auto-insert recovered text** | Off | When enabled, recovered text is inserted into the chat automatically without prompting. Recommended once you have confirmed reliable recovery in your setup. |

The **Proxy Container** section of the settings panel shows whether the proxy is reachable. If it shows *Not detected*, check that the Docker container is running and that NPM is forwarding to it correctly.

---

## Limitations

| Scenario | Outcome |
|---|---|
| Cloud API (Claude, OpenAI, Gemini...) | Works — proxy keeps the upstream connection alive. |
| Local LLM that aborts on client disconnect | Nothing to recover — generation stops on disconnect. |
| Local LLM that doesn't abort (e.g. KoboldCpp `--no-abort`) | Works. |
| Backend still generating when you return | Works — long-poll waits for completion (up to ~6 min). |
| You manually stopped generation before locking | No spurious recovery — stop events clear the pending state. |
| You switched to a different chat | No spurious recovery — chat change resets state. |
| Proxy entry expired (> 30 min) | Falls back to a direct reload; works if ST saved the response to disk. |

---

## A Note on the Silence Player

The official [Silence Player](https://github.com/SillyTavern/Extension-Silence) extension plays a silent audio loop to try to keep the browser tab alive in the background. **It is not recommended alongside Stream Lazarus**, for two reasons:

1. **Music interference** — iOS audio sessions are exclusive. The silent audio competes with Spotify, Apple Music, etc.
2. **iOS still wins** — after ~5–15 minutes locked, or when another app claims the audio session, iOS suspends the tab anyway.

Stream Lazarus is designed to *embrace* the disconnect rather than fight it. Use it alone.

---

## Troubleshooting

**Proxy shows "Not detected" in the settings panel**

Check that the `stream-lazarus` Docker container is running (`docker ps`) and that NPM is forwarding to `stream-lazarus:3000`. The health endpoint is `/_slproxy/health`.

**"No response found" even though the backend finished**

Confirm your LLM backend is not configured to abort on disconnect. For cloud APIs this is never an issue. For KoboldCpp and similar, add the appropriate `--no-abort` flag.

**Recovery triggers when I cancel generation intentionally**

It shouldn't — Stream Lazarus listens for `GENERATION_STOPPED` and clears the pending state. If you see unexpected recovery, open an issue with your ST version and API type.

**Group chats not recovering**

`reloadCurrentChat()` handles both solo and group chats automatically. If group recovery is failing consistently, open an issue.

---

## License

AGPL-3.0 — see [LICENSE](LICENSE)

---

<div align="center">
  <sub>Built for the SillyTavern community · Tested on iPhone 15 Pro / iOS 18</sub>
</div>

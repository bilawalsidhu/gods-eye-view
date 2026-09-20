# Remote companion (remote.html)

A phone or second screen for the LOCAL voice assistant (`AI_PROVIDER=ollama`).
The page mirrors what the globe hears and says, and lets you type or tap
commands that run on the globe. Replies are spoken on the globe machine; the
remote shows text only.

## Opening it

1. Start the local stack as usual (`scripts/dev-local.ps1` or
   `scripts/dev-local.sh`) and on the globe page tap **MIC** so a voice
   session exists. The remote can only drive a session the globe has opened.
2. Same machine: <http://localhost:4173/remote.html>.
3. Phone on the same Wi-Fi: set `HOST=0.0.0.0` in `.env`, restart, then open
   `http://<pc-ip>:4173/remote.html`. The page header shows the host it is
   talking to. Find the PC address with `ipconfig` (Windows) or `ip addr`.

The status pill reads `CONNECTING` / `OFFLINE` (socket), `NO SESSION` (no MIC
session on the globe), `SESSION ACTIVE`, `THINKING`, `RUNNING` (a tool call is
executing on the globe) or `NOTHING HEARD`. The socket reconnects with
exponential backoff (1 s doubling to 15 s) and immediately when the tab
returns to the foreground.

## What works where

| Feature | Plain `http://<pc-ip>` from a phone | `localhost` or HTTPS |
| --- | --- | --- |
| Live transcript (heard text, tool calls, replies, errors) | yes | yes |
| Typed commands and the quick-action chips | yes | yes |
| Interrupt the current reply | yes | yes |
| Phone microphone (hands-free VAD, WAV to the globe) | no | yes |

Browsers only expose `getUserMedia` in a secure context, and the dev server has
no HTTPS mode, so over the LAN the page shows "Mic needs HTTPS or localhost;
text works everywhere" and hides the MIC button. Everything else is text over
the WebSocket and needs nothing from the phone.

Lines are tagged `YOU` (typed on a remote), `MIC` (spoken into the globe or a
remote mic), `GEV` (the assistant's reply), `RUN` (a tool call with its
arguments), `SYS` and `ERR`.

## How it is wired

- `server/providers/ollama/remote.js` — `createRemoteHub()`; the Ollama
  provider plugin installs the shared hub's WebSocket at `/api/voice/remote`
  (`VOICE_REMOTE_WS_PATH` overrides). It keeps its own `upgrade` listener next
  to the voice socket's.
- `server/providers/ollama/voice.js` — each voice session registers
  `{ sendText, interrupt, sendUtterance }` with the hub after `ready`, publishes
  every outbound frame except `audio_chunk`, and unregisters on close. The
  most recently opened session is the target for remote commands.
- `src/remote/main.js`, `src/remote/remoteFeed.js`, `src/remote/remote.css`
  — the page. `remoteFeed.js` is pure (frame -> lines/status) and unit tested;
  it reuses `localSessionEvents` from `src/voice/localVoiceProtocol.js`.

Hub frames to a remote: `{type:'sessions', active:[ids]}`,
`{type:'session', sessionId, frame}`, `{type:'ack', command, sessionId}`,
`{type:'error', error}`. Remote to hub: `{type:'text', text}`,
`{type:'interrupt'}`, binary WAV then `{type:'audio_end'}`. A command with no
active session answers `No voice session is active on the globe; tap MIC there
first`.

## Security note

`HOST=0.0.0.0` exposes the whole dev server to the network, including every
key-brokering proxy (`/api/google/*`, `/api/realtime/token`, ...), not just the
remote page. Anyone on the Wi-Fi can also open `remote.html` and drive the
globe. Use it on networks you trust, consider the `GEV_RATELIMIT_*` throttles,
and switch back to `HOST=localhost` afterwards. The remote never receives audio
or any key.

Both voice sockets (`/api/voice/ws`, `/api/voice/remote`) and `/api/voice/config`
check the browser `Origin` against the served host, so a web page you happen
to visit cannot open the companion socket to `localhost` and read or inject
commands (cross-site WebSocket hijacking), and a DNS-rebound host name gets
403. Non-browser clients send no `Origin` and are admitted; the LAN caveat
above is unchanged. `scripts/dev-local.sh` now binds `localhost` unless `HOST`
is set, matching the Windows launcher.

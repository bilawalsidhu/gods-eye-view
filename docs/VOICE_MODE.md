# OD VOICE — OnDemand voice mode (streaming, turn-based)

**Advanced/realtime voice is NOT available in the live OnDemand public API
(no WebSocket/WebRTC surface; `advancedVoiceMode` is a Flow Builder node for
telephony agents); this implementation is streaming turn-based on OnDemand
STT → chat/workflow → TTS.**

OnDemand is the only AI/voice/reasoning provider. The legacy OpenAI Realtime
stack under `src/voice/*` is untouched and stays disabled in serverless mode
(`/api/realtime/token` → 501). OD VOICE is a separate module family,
`src/voice/ondemand/`, active in both the Vite dev build and the serverless
build (wired from `src/main.js` after `application.start()` resolves).

## Architecture

```
 browser (src/voice/ondemand/)                         same-origin proxy (api/ondemand/*.js, server/serverless/app.js)          OnDemand
 ─────────────────────────────                         ───────────────────────────────────────────────────────────────         ────────
 ui.js  ──press──▶ pipeline.js ──▶ audio.js (getUserMedia + MediaRecorder + AnalyserNode)
                        │
                        │ blob            POST /api/ondemand/media  (multipart, forwarded verbatim)  ───────────────────▶ POST {media}/raw      → data.url
                        ├──────────────▶  POST /api/ondemand/stt    {audioUrl}                        ───────────────────▶ speech_to_text        → data.text
                        │ transcript
                        ├─ intents.js (local fast path: dataManager.setEnabled, no network)
                        │
                        ├─ route 'workflow' ─▶ POST /api/ondemand/workflow/execute   (catch-all sub-path → ?action=execute) ─▶ POST /workflow/{id}/execute → {executionID}
                        │                      GET  /api/ondemand/workflow/status|logs|outputs?executionId=  (poll, 1 s → 3 s, ≤ 90 s)
                        │
                        ├─ always ──────────▶ POST /api/ondemand/sessions {userId}  (once per page)         ─▶ POST /chat/v1/sessions
                        │                     POST /api/ondemand/chat {sessionId, query, responseMode:'stream'} ─▶ …/query (SSE piped verbatim)
                        │ answer (+ MAPACTIONS line)  ─▶ gevActions runner (28 MapAction names)
                        │
                        └─ speaking ───────▶ POST /api/ondemand/tts?format=audio {input, voice} ─▶ text_to_speech → mp3 bytes → HTMLAudioElement
```

Modules:

| File | Role |
| --- | --- |
| `src/voice/ondemand/pipeline.js` | Pure state machine (`idle → listening → transcribing → thinking → speaking → idle`, `error`), injectable transport/recorder/player/timers |
| `src/voice/ondemand/transport.js` | fetch wrappers for the proxy, SSE fold, execute + documented polling, `x-ondemand-key` injection |
| `src/voice/ondemand/intents.js` | local fast-path layer intents, route classifier, `MAPACTIONS` extraction |
| `src/voice/ondemand/audio.js` | `createSilenceDetector` (pure RMS state machine), browser recorder + player |
| `src/voice/ondemand/ui.js` | the OD VOICE control (button + status chip + transcript/answer/workflow lines) |
| `src/voice/ondemand/index.js` | wiring: scene context, layer toggles, MapAction runner, `window.__odVoice` |
| `server/serverless/ondemand-workflow-mount.js` | `/api/ondemand/workflow/<sub>` → `?action=` rewrite + the SSE re-shaping of polling |

## The turn

1. **listening** — press `#od-voice-button` (or `window.__odVoice.press()`). `getUserMedia({audio:true})`,
   `MediaRecorder` (opus/webm where supported, 250 ms timeslices) and an `AnalyserNode` RMS loop
   every 50 ms. Recording stops on: a second press, the energy detector reporting ≈ 1.2 s of
   silence **after** speech (threshold 0.012 RMS, ≥ 120 ms sustained speech to arm), or the
   **12 s utterance cap** (pipeline timer).
2. **transcribing** — the blob is uploaded, then transcribed (two calls; the proxy's STT accepts
   only `audioUrl`, contract §6.1 — raw upload is 501 there by design).
3. **thinking** — local intents first (see table), then the route:
   - `chat` — session (once per page) + streaming chat; the answer accumulates from
     `fulfillment` deltas ordered by `eventIndex`; `statusLog`, `metricsLog`,
     `fulfillment_thinking` and `heartbeat` frames are recorded, never spoken; `[DONE]` ends,
     `[ERROR]:` raises.
   - `workflow` (default when the transcript reads like a spatial task, see `classifyRoute`) —
     the same chat turn **plus** the OnDemand Spatial workflow trigger in parallel: execute →
     poll `status`+`logs` with 1 s → 1.5 s → 2.25 s → 3 s backoff (≤ 90 s) → `outputs` →
     parse the final `structured_response` node (7-key StructuredResponse) → `message` +
     `actions` (normalised to `{name, args}`), `timeToFirstLogMs` recorded.
4. **speaking** — TTS bytes → `Blob` → `HTMLAudioElement`. While speaking a second
   `AnalyserNode` (threshold 0.045 RMS held ≥ 260 ms, to ignore speaker bleed) listens for
   barge-in.
5. **idle** — the status detail line reads `stt N ms · first delta N ms · tts N ms · workflow
   <status> · first log N ms`.

### Barge-in rules

- Pressing the button while **speaking** (or the monitor hearing speech) → `player.stop()`
  immediately, the turn's `AbortController` aborts pending TTS/playback, the **pending workflow
  poll is abandoned** (its own `AbortController`, `workflow` event `phase:'abandoned'`), and a
  new `listening` turn starts.
- Pressing while **listening** sends; while **transcribing/thinking** cancels back to `idle`;
  while **idle/error** starts listening.
- A new turn (press or `submitText`) always abandons the previous turn's pending workflow poll
  so two executions never overlap.

## Exact proxy calls (browser → same-origin proxy)

Every call carries `x-ondemand-key: <localStorage ondemand.apiKey>` **only when that key exists**
(Settings drawer); the key is read at request time, never logged, never rendered, never emitted
in any pipeline event.

| Step | Method + path | Body | Notes |
| --- | --- | --- | --- |
| upload | `POST /api/ondemand/media` | `multipart/form-data`: `file` (blob, `utterance.webm`), `name`, `sessionId` (when known), `plugins=plugin-1713958830` (Audio Agent), `sizeBytes`, `responseMode=sync` | proxy forwards verbatim to `{media}/raw` (§5.2); response `data.url` |
| STT | `POST /api/ondemand/stt` | `{"audioUrl": "<data.url>"}` | §6.1 exactly one field; response `data.text` |
| session | `POST /api/ondemand/sessions` | `{"userId": "ondemand-spatial-voice-<yyyy-mm-dd>"}` | once per page; response `{sessionId, reused}` |
| chat | `POST /api/ondemand/chat` (`Accept: text/event-stream`) | `{"sessionId", "query", "responseMode": "stream"}` | the proxy's §3.1 allow-list rejects any other top-level key, so the **scene context travels inside `query`** (see below) |
| execute | `POST /api/ondemand/workflow/execute` | `{}` (or `{"workflowId"}`) | **input-less per contract §7.1** — the proxy answers 501 to `input`/`payload`; response `{executionID}` |
| status / logs / outputs | `GET /api/ondemand/workflow/status?executionId=` · `/logs?…` · `/outputs?…` | — | documented polling; no upstream log stream exists |
| TTS | `POST /api/ondemand/tts?format=audio` (`Accept: audio/mpeg, …`) | `{"input": "<≤4096 chars>", "voice": "alloy"}` | mp3 bytes (`Content-Type` may be `application/octet-stream`, re-typed to `audio/mpeg`); a JSON envelope fallback carries `data.audioUrl`, which is played directly |
| catalogue | `GET /api/tools` | — | `{tools:[{id,name,tools:[{name,path,params}]}]}`, cached 5 min, failures → `[]` |

### How the workflow gets its input (it does not)

`POST /workflow/{id}/execute` defines **no request body** in the live contract and the proxy
refuses `input`/`payload` with 501, so the utterance can never reach the workflow. The workflow
therefore runs as an **input-less trigger** alongside the chat turn; the transcript **and** the
scene context always travel via the chat `query`, which is what produces the spoken answer. The
workflow's own `StructuredResponse` is still parsed: its `message` is used as the spoken fallback
when chat fails, and its `actions` are dispatched as MapActions when they arrive.

### Chat query shape

```
<transcript>

[ondemand-spatial voice turn]
You are the spoken assistant of the OnDemand Spatial globe. Answer in at most two short plain-text sentences … Layers listed as localActionsApplied were already toggled …
If a map change would help, end with exactly one line: MAPACTIONS: [{"name":"<action>","args":{...}}] using only these action names: fly_to_location, … next_iss_pass. Otherwise omit that line.
Scene context (JSON): {"camera":{"lat","lon","heightM","headingDeg"},"scene","locality","layers":[{"id","enabled","state?","reason?","count?"}],"tools":[{"id","tools":[names]}],"localActionsApplied":[{"layerId","enabled","ok"}],"route","utc"}
```

Context is bounded (≤ 12 000 chars; ≤ 16 layers; tools dropped first, then layers trimmed).
Layer `state`/`reason` come from `dataManager.getAll()` stats through `src/data/feedState.js
layerFeedState`.

## Local fast-path intents (before any network call; work when OnDemand is down)

`matchLayerIntents(transcript)` → `dataManager.setEnabled(id, bool, { origin: 'voice' })`. Verbs:
enable = `show|enable|turn on|switch on|display|activate|bring up|put up|add|light up|pull up|reveal|start`;
disable = `hide|disable|turn off|switch off|remove|deactivate|kill|drop|clear|take off|stop showing|get rid of`.
Clauses split on `, ; and then but plus`; a clause without a verb inherits the previous one.
"near me" / "in the scene" are implicit and ignored.

| Phrase family | Layer id |
| --- | --- |
| military, military flights/aircraft/planes/traffic, warplanes, fighter jets | `military` |
| (live/civil/commercial/air) flights, aircraft, airplanes, planes, air traffic, airliners, jets | `flights` (never when the clause also says military) |
| vessels, ships, boats, shipping, maritime traffic, AIS | `ais-live-vessels` |
| satellites, sats, orbits, orbital tracks | `satellites` |
| (road/street/car/vehicle) traffic — not air/maritime/shipping traffic | `traffic` |
| transit, bus(es), train(s), subway, metro, light rail, rail, tram(s), streetcar(s) | `transit` |
| bikeshare, bike(s), bicycles, citi bike, cycle hire | `bikeshare` |

So "show military flights near me" enables `military` immediately and still asks OnDemand for
the spoken answer; when the proxy answers 501/503/404 (or the network fails) the pipeline speaks a
local confirmation ("Military flights layer on.") and shows the reason in the detail line.

## MapAction dispatch contract

- Sources: the chat answer's `MAPACTIONS: [{name, args}]` line (also a fenced/bare JSON object with
  `mapActions`/`actions`), and the workflow StructuredResponse `actions[] {name, params, reason}`.
- `normalizeMapActions` maps `params → args` and **drops any name outside the 28 schemas in
  `src/voice/actionSchemas.js`**.
- Execution: `runner(name, args, { signal })` where `runner` is the app's existing
  `createGevActionRunner` instance (`components.tools.voiceCommands.runner`, i.e. the same one the
  legacy voice controller holds), created lazily from `src/voice/gevActions.js` with the debug
  handle's `viewer/styleManager/dataManager/sceneDirector/annotations` if none exists. Results are
  emitted as `{type:'actions', source:'chat'|'workflow', actions, results:[{name, ok, result|error}]}`.

## `/api/ondemand/workflow/<sub-path>` (server)

Vercel routes the literal `api/ondemand/workflow.js` only for the bare path; sub-paths fall into
the catch-all (`api/[...route].js` → `server/serverless/app.js`). `mountOndemandWorkflowSubpaths`
(registered before the provider loop) rewrites `req.url` to
`/api/ondemand/workflow?action=<sub>&<original query>` and delegates to the handler's default
export (dynamic import), for `execute`, `status`, `logs`, `outputs`. Unknown sub-path → 404
`unknown_workflow_subpath`; the bare path falls through untouched.

`GET /api/ondemand/workflow/stream?executionId=…[&afterLogs=N]` is a same-origin SSE that polls
`status` + `logs` server-side every 1.5 s **through the same handler** and emits
`event: open` → `event: status` / `event: log` … → `event: done` (`{status, executionId,
timeToFirstLogMs, totalMs, logCount, resume, structuredResponse?, nodeKeys?, timeTakenInMilliseconds?}`),
plus `event: error` on a failed poll. It is the documented polling surface re-shaped as SSE — **not**
an upstream streaming endpoint (`?action=stream-logs` on the handler stays 501 for that reason).
Its own budget is 50 s (under the function's 60 s `maxDuration`): `status:'timeout', resume:true`
means reopen with `afterLogs=logCount`. The response carries `X-OnDemand-Stream: polling-reshaped`.

## UI

`#od-voice-control[data-state][data-route]` sits in `#command-dock` immediately after the existing
`#gev-voice-control` (moved there by `ui.js`; the GEV MIC button is untouched). Children:
`#od-voice-button` (label TALK/SEND/WAIT/STOP/CUT IN/RETRY, `aria-pressed` while busy),
`#od-voice-status` (IDLE/LISTENING/TRANSCRIBING/THINKING/SPEAKING/ERROR), `#od-voice-detail`
(reason/telemetry), `#od-voice-route` (AUTO → WF → CHAT), `#od-voice-transcript`, `#od-voice-answer`
(`data-partial`, `data-source`), `#od-voice-workflow`. Styles: `src/ui/styles/voice-ondemand.css`.

Headless driving: `window.__odVoice.submitText('show military flights near me')` runs a full turn
without a microphone; `window.__odVoice.press()`, `.getState()`, `.getDetail()`, `.subscribe(fn)`,
`.setMode('chat'|'workflow'|'auto')`, `.getHistory()`, `.health()`, `.hasKey()`.

## Limits

| Limit | Value |
| --- | --- |
| utterance cap | 12 s |
| silence stop | ≈ 1.2 s after speech |
| workflow poll budget | 90 s (1 s → 3 s backoff) |
| TTS input | 4 096 chars |
| chat context | ≤ 12 000 chars, ≤ 16 layers |
| server SSE stream | 50 s per connection (resumable) |

## Tests (offline)

`node --test src/voice/ondemand/pipeline.test.mjs src/voice/ondemand/intents.test.mjs src/voice/ondemand/transport.test.mjs src/voice/ondemand/ui.test.mjs`
and `npm run test:serverless` (sub-path mapping + SSE re-shaping in `server/serverless/app.test.mjs`).

## Verification (filled from the deployed preview, 2026-09-18 UTC)

Preview `https://sb-1dqoce558p0v.vercel.run` — Vercel Sandbox, node 24, `dev:serverless` over `dist` +
`api`; runtime env `ONDEMAND_API_KEY`, `ONDEMAND_BASE_URL`, `ONDEMAND_SELFTEST_TOKEN`,
`GODS_EYE_FLOW_VERSION=1`, `ONDEMAND_SPATIAL_WORKFLOW_ID` (names only). Server-side checks with
`curl`; browser checks in headless Chromium 1440×900 through the `ui-validator` driver
(`window.__odVoice.submitText` is the documented text entry point — **microphone capture cannot run
headless**, so the STT leg was exercised by the selftest's in-script WAV instead, step 5 PASS).

| Check | Result |
| --- | --- |
| Preview URL | `https://sb-1dqoce558p0v.vercel.run` |
| `GET /api/ondemand/health` → `workflow` status | **`healthy`** (16:57:22Z; `ondemand`/`chat`/`speech`/`media` all `healthy`; `config.flowVersion = { configured: true, source: GODS_EYE_FLOW_VERSION, resolvedVia: alias }`, `config.spatialFlowId = { configured: true, source: ONDEMAND_SPATIAL_WORKFLOW_ID, resolvedVia: canonical }`) |
| `POST /api/ondemand/workflow/execute` → `executionID` | `{"executionID":"6aad6db187fc428d7c18a4bc"}` — HTTP 200 in 0.49 s at **16:58:25Z** (body `{}`; the workflow has no input node) |
| `GET /api/ondemand/workflow/stream?executionId=…` → first `event: log` after | **436 ms** after the stream opened (`event: open` at +79 ms, first `event: status` at +226 ms, `event: log` #1 "starting workflow execution" at +436 ms; platform-side the first log is stamped 14 ms after `startedAtInMilliseconds`). A second attach 41 s later reported `timeToFirstLogMs: 379` in its `done` frame. Response header `X-OnDemand-Stream: polling-reshaped`, `content-type: text/event-stream`. |
| `done` frame `status` / `totalMs` / `structuredResponse.runMeta.flowVersion` | First 50 s window: `event: done` `{"status":"timeout","timeToFirstLogMs":379,"totalMs":49103,"logCount":17,"resume":true}` — the workflow outlives one stream budget by design. Polled `GET /api/ondemand/workflow/status` every 10 s → **`success`** at 17:01:08Z (`endedAtInMilliseconds` = 17:01:02.292Z, `timeTakenInMilliseconds` **156 649**). `GET /api/ondemand/workflow/outputs` (17:43:02Z) → `structured_response.value.runMeta = { workflow: "GodsEye Advanced Spatial Workflow", **flowVersion: 1**, mode: "selftest", intent: "anomaly_scan", tier: "INVESTIGATE", confidence: 0.98, selectedCapabilityIds: ["earthquake.search"], … }`, 10 node outputs (`trigger`, `session_context`, `spatial_context_builder`, `intent_classifier`, `capability_resolver`, `planner`, `spatial_action_planner`, `verification`, `synthesis`, `structured_response`). Event sequence over the two attaches: `open` → `status` → `log`×2 → `status`×N interleaved with `log` → … → `done` (17 logs, 28 status frames in the second attach). |
| `window.__odVoice.submitText('show military flights near me')` → military layer enabled, spoken answer | Submitted **17:34:42.232Z** (`#od-voice-control[data-state]` → `thinking` immediately). Local fast-path: **military layer `enabled: true` within 3.6 s** (`stats.status 200`, 106–108 aircraft; DATA LAYERS `Military Flights · LIVE · adsb.lol`). OnDemand turn: `getDetail()` → `first delta 2142 ms · tts 2702 ms · workflow running…`; `submitText` resolved at +10.8 s with `state: idle`, `route: AUTO` chip `IDLE`, `#od-voice-answer` = "Military flights are shown near you in Austin, with 106 aircraft detected. The military flights layer is enabled." (metrics keys `startedAt, chatMs, chatFirstDeltaMs, chatMessageId, ttsMs, ttsError, workflow`; spoken via TTS — audio output is not audible headless). Parallel input-less workflow: `#od-voice-workflow` = `workflow 6aad7633230c7d9c39f19a6c: timeout · first log 4106 ms · total 87175 ms · 0 action(s)` (`metrics.workflow = { status: "timeout", ok: false, timeToFirstLogMs: 4106, totalMs: 87175, polls: 20, logCount: 17, actionCount: 0 }`) — the client poll budget ends before the workflow does; server-side that execution reached **`success`** at 17:37:16.009Z (`startedAtInMilliseconds` 17:34:43.726Z, `timeTakenInMilliseconds` 152 283; confirmed by `/api/ondemand/workflow/status` at 17:37:17Z). An earlier identical turn (17:33:54Z, execution `6aad7604b9fa0128677543f9`) behaved the same: military on at +3.2 s, first delta 2566 ms, tts 2503 ms, server `success` in 149 623 ms. Screenshot `.ui-proof/e2e-voice-1440x900.png` (after-only). |
| barge-in during speaking → `workflow phase:'abandoned'` event | not exercised this pass (no audio device headless; covered offline by `src/voice/ondemand/pipeline.test.mjs`) |
| No `x-ondemand-key` header without a stored key; header present after setting `localStorage.ondemand.apiKey` | Without a stored key the proxy answered `x-ondemand-key-source: server` (`POST /api/ondemand/sessions`, HTTP 201, 17:42:10Z) and the entity-chat key state read `server key`; the stored-key branch was not exercised live (covered by `server/ondemand/key-override.test.mjs`) |

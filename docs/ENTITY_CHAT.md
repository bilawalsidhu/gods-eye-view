# ASK ONDEMAND — per-entity mini chatbot

A small OnDemand chat that opens on a selected **aircraft**, **vessel** or
**satellite**. It sends OnDemand a structured snapshot of what the operator is
looking at (the entity, the camera scene with its MGRS reference, the status
of every data layer exactly as the DATA LAYERS panel prints it, the nearest
contacts and the tool catalogue), then streams answers token by token.

| Piece                                | Where                                                             |
| ------------------------------------ | ----------------------------------------------------------------- |
| Context payload builder (pure)       | `src/ondemand/entityContext.js` (`buildEntityContext`, `entitySystemPrompt`) |
| Overlay controller + proxy transport | `src/ondemand/entityChat.js` (`createEntityChat`, `installEntityChat`)      |
| Wiring into the app                  | `src/app/tools.js` → `window.__godsEyeView.entityChat`             |
| Button in the CONTEXT ▸ CONTACTS panel | `src/ui/templates/context.html` → `#ask-ondemand-btn`            |
| Styles                               | `src/ui/styles/ondemand-chat.css` (imported from `style.css`)     |
| Proxy key override                   | `server/ondemand/client.js` (`resolveRequestKey`, `ondemandFetch({ apiKeyOverride })`) |
| Tests                                | `src/ondemand/*.test.mjs`, `server/ondemand/key-override.test.mjs` |

## What opens the overlay

The tracking layers already publish their selection on two window events —
`gev:awareness-subject-selected` (flights, military, satellites — detail
`{ layerId, id, label, position, origin }`) and `gev:entity-selected` (live AIS
vessels — detail is the context-store record) — and the matching
`…-cleared` events. `installEntityChat` listens to all four:

1. A selection on `flights` / `military` / `ais-live-vessels` / `satellites`
   reveals **ASK ONDEMAND** (`#ask-ondemand-btn`, in the CONTEXT ▸ CONTACTS
   action row next to COCKPIT / SEARCH NEARBY SITES). Any other layer keeps it
   hidden.
2. Clicking it calls `controller.openSelected()`, which resolves the live
   descriptor through the layer's own accessor (`getTrackedInfo()` for
   aircraft/satellites, `getSelectedInfo()` for vessels) merged with the
   shared context-store record (`window.__gevContextStore`), builds the
   context and appends `#ondemand-entity-chat` to `document.body`.
3. Selecting a different entity while the overlay is open re-targets it (new
   session, fresh transcript). Clearing the selection hides the button but
   keeps the overlay and its session.

Programmatic entry points (all on `window.__godsEyeView.entityChat`):

| Call                                                     | Effect                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `open({ entity, kind })` / `open({ entity, layerId })`   | Open for an arbitrary record (`kind` ∈ `aircraft` \| `vessel` \| `satellite`).           |
| `openSelected()`                                         | Open for the current globe selection (what the button does).                             |
| `openFirstVisible('aircraft' \| 'vessel' \| 'satellite')` | Headless harness helper: `layer.getAllPositions(1)[0]` → `trackById` / `selectById` → open. |
| `send(text)`                                             | Stream one message; resolves with `{ firstTokenMs, totalMs, chars, ok, error }`.        |
| `close()`, `destroy()`, `setApiKey(value)`, `getState()`, `getContext()` | Housekeeping / inspection (`getState()` never contains the key).           |

Selectors (exported as `SELECTORS` from `src/ondemand/entityChat.js`):

| Purpose            | Selector                             |
| ------------------ | ------------------------------------ |
| Button             | `#ask-ondemand-btn`                  |
| Overlay            | `#ondemand-entity-chat` (`data-open`, `data-entity-kind`, `data-entity-key`) |
| Header title / MGRS | `#ondemand-entity-chat-title`, `#ondemand-entity-chat-mgrs` |
| Status line        | `#ondemand-entity-chat-status`       |
| First-token badge  | `#ondemand-entity-chat-latency` (`data-ms`, text `first token in N ms`) |
| Key indicator      | `#ondemand-entity-chat-key-state` (`data-key-source="request|server"`, text `using your key` / `server key`) |
| Key field          | `#ondemand-entity-chat-key-toggle` → `#ondemand-entity-chat-key-row`, `#ondemand-entity-chat-key` (password), `#ondemand-entity-chat-key-save`, `#ondemand-entity-chat-key-clear` |
| Transcript         | `#ondemand-entity-chat-transcript`, messages `.od-chat__msg--user|assistant|system|error` (`data-role`, `data-streaming` while tokens arrive) |
| Composer           | `#ondemand-entity-chat-input`, `#ondemand-entity-chat-send`, `#ondemand-entity-chat-close` |

## Context payload (`schema: ondemand-spatial/entity-chat/1`)

Built by `buildEntityContext({ entity, kind, viewer, dataManager, scene, tools, health, now, satellitesOverhead })`.
Every value is JSON-safe — missing data is `null`, never `undefined`/`NaN`
(pinned by `entityContext.test.mjs`).

```jsonc
{
  "schema": "ondemand-spatial/entity-chat/1",
  "generatedAtUtc": "2026-09-18T12:00:00.000Z",
  "entity": {
    "kind": "aircraft",                 // aircraft | vessel | satellite
    "id": "a1b2c3",
    "callsign": "UAL1234",              // vessel/satellite: "name"
    "icao24": "a1b2c3",                 // vessel: "mmsi", satellite: "noradId"
    "lat": 30.2672, "lon": -97.7431,
    "altitudeM": 10668, "speedMps": 236.4, "headingDeg": 272,
    "squawk": null,
    "sourceFeed": "OpenSky",
    "observedAtUtc": "2026-09-18T11:59:57.000Z",
    "route": { "origin": "AUS", "destination": "SFO" },   // aircraft only; vessel adds imo/shipType/destination/speedKt/courseDeg, satellite adds group
    "raw": { /* the layer record trimmed to ≤ 40 primitive fields */ }
  },
  "scene": {
    "name": "Austin, TX",               // location mini-status, else "lat, lon"
    "bbox": { "lamin": 29, "lomin": -99.5, "lamax": 31.5, "lomax": -96 },   // camera view rectangle, else ±2°
    "camera": { "lat": 30.4, "lon": -97.8, "heightM": 120000 },
    "coordinates": { "lat": 30.2672, "lon": -97.7431, "mgrs": "14R PU 2090 4906" }
  },
  "layers": [                            // EVERY registered layer
    { "id": "flights", "label": "Live Flights", "enabled": true, "feedState": "nominal",
      "statusText": "LIVE · OpenSky · 12s ago",   // exact DATA LAYERS row text (dataManager._buildMetaText)
      "source": "OpenSky", "providerStatus": "live", "providerError": null, "count": 812 }
  ],
  "nearby": {
    "radiusKm": 250, "satelliteRadiusKm": 1500,
    "satelliteSource": "list_satellites_in_scene",   // or "satellites-layer" when the tool is unavailable (404 tolerated)
    "aircraft":   [ { "id", "label", "lat", "lon", "altitudeM", "distanceKm", "bearingDeg", "military", "typeCode", "origin", "destination" } ],   // ≤ 10, nearest first, subject excluded
    "vessels":    [ { "id", "label", "lat", "lon", "altitudeM", "distanceKm", "bearingDeg" } ],
    "satellites": [ { "id", "label", "lat", "lon", "altitudeM", "distanceKm", "bearingDeg", "group", "elevationDeg" } ]
  },
  "tools": {
    "catalogue": [ { "id", "name", "tools": [ { "name", "path", "params": ["lat", "lon", "…"] } ] } ],   // GET /api/tools
    "workflow": { "id": null, "idSource": "default", "versionLabel": null, "versionSource": "GODS_EYE_FLOW_VERSION",
                  "resolvedVia": "alias", "configured": true, "ondemand": "healthy" }   // GET /api/ondemand/health `config` — names only
  },
  "limits": { "maxNearby": 10, "contextByteBudget": 28672 }
}
```

`entitySystemInstruction(context)` is the ≤ 2 KB analyst instruction
("You are the OnDemand Spatial analyst… reply with exactly: READY"; answers
concise, units stated, never invent data, flag DEGRADED/STALE/FALLBACK layers,
optional trailing `MapAction: {"action":"flyTo|track|enableLayer","target":…}`
line). `entitySystemPrompt(context)` = instruction + `CONTEXT_JSON:` + the JSON,
shrunk by `fitContextToBudget` (raw → tool params → nearby → catalogue →
layers) so it always stays under the proxy's 32 KiB query cap.

## Proxy calls

All same-origin, all through `api/ondemand/*`; the browser never talks to
OnDemand directly and never sees the server key.

| Step | Request | Notes |
| ---- | ------- | ----- |
| session | `POST /api/ondemand/sessions` `{ "userId": "ondemand-spatial-entity-<yyyy-mm-dd>", "reuse": false }` → `{ sessionId }` | one upstream session per entity id, cached in memory (`entityKey = kind:id`) for the page lifetime; `reuse:false` because the proxy's store is keyed by `userId` |
| context turn | `POST /api/ondemand/chat` `{ sessionId, query: <entitySystemPrompt>, responseMode: "sync", fulfillmentOnly: true }` | runs once per entity when the overlay opens; the reply (`READY`) and its latency show as a system line |
| each message | `POST /api/ondemand/chat` `{ sessionId, query, responseMode: "stream" }` (`Accept: text/event-stream`) | SSE piped verbatim by the proxy; `fulfillment` deltas are appended as they arrive, `statusLog` messages update the status line, `data:[DONE]` ends the turn, `data:[ERROR]:{…}` is rendered |
| inputs | `GET /api/tools`, `GET /api/ondemand/health`, `GET /api/tools/list_satellites_in_scene?lat&lon&radiusKm=1500&limit=10` | tolerant: a 404/failed fetch leaves that block empty |

`endpointId` is omitted so the proxy applies `ONDEMAND_FULFILLMENT_ENDPOINT_ID`
(default `predefined-gpt-5.6-luna`); `createEntityChat({ endpointId })` can pin
one. Proxy failures (`503 not_configured`, `501` not-documented, `429
rate_limit_exceeded`, `502 proxy_error`, …) render the proxy's own envelope as
`proxy <status> · <error> · <message>`.

**Why the context is a query turn, not session metadata.** The live docs
(`docs/ONDEMAND_API_CURRENT.md` §2) define no `contextMetadata` on
`POST /chat/v1/sessions` (it is live-accepted but undocumented and the proxy
forwards documented fields only), and `PUT /chat/v1/sessions/{id}/live-settings`
is the proactive/on-events notification mode — not a context channel. The
first turn is therefore the context, sent `sync` + `fulfillmentOnly` so it costs
one fast model call and no RAG pass; the session then remembers it for every
streamed turn.

## Key override (`x-ondemand-key`)

Operators may use their **own** OnDemand key from the browser:

- Stored only in `localStorage["ondemand.apiKey"]` (overlay header → **KEY** →
  password field → SAVE; CLEAR removes it). The field is never pre-filled and
  is emptied after saving; the indicator reads **using your key** / **server key**.
- Sent **only** as the request header `x-ondemand-key` on
  `POST /api/ondemand/sessions` and `POST /api/ondemand/chat`. Never in a body,
  a URL, the DOM, `getState()` or a console line (the controller has no
  `console.*` calls). Not sent to `/api/tools` or `/api/ondemand/health`.
- Proxy rules (`server/ondemand/client.js`): the header must be a non-empty
  printable-ASCII string of ≤ 128 chars — otherwise `400 invalid_key_override`
  and no upstream call. When valid, `ondemandFetch(url, { apiKeyOverride })`
  uses it as the upstream `apikey` for **that request only**; the substitution
  lives in that one function. A valid header also lets an unconfigured server
  (no `ONDEMAND_API_KEY`) serve the request.
- Every sessions/chat response carries `X-OnDemand-Key-Source: request|server`
  — a name, never a value. Sessions created with a caller key are never
  written to the proxy's `userId → sessionId` store (they belong to a
  different OnDemand company), and a stored server-key session is never
  reused for a caller-key request.
- `api/ondemand/health.js` and `api/ondemand/selftest.js` never read the
  header (pinned at source level and live in `key-override.test.mjs`).

## Verification (filled from the deployed preview, 2026-09-18 UTC)

Headless Chromium 1440×900 through the `ui-validator` driver against the Austin scene
(`#lat=30.2672&lon=-97.7431&alt=1200&pitch=-35`); flights layer enabled programmatically after the
camera restore, 25 s data wait, then the headless recipe below. Runtime env on the preview:
`ONDEMAND_API_KEY`, `ONDEMAND_BASE_URL`, `ONDEMAND_SELFTEST_TOKEN`, `GODS_EYE_FLOW_VERSION`,
`ONDEMAND_SPATIAL_WORKFLOW_ID` (names only; no user key in `localStorage`).

| Check | Value |
| ----- | ----- |
| Preview URL | `https://sb-1dqoce558p0v.vercel.run` (Vercel Sandbox, node 24, `dev:serverless`) |
| Entity opened (`data-entity-key`) | `aircraft:a06656` — `openFirstVisible('aircraft')` resolved at **17:32:39Z** with `#ondemand-entity-chat[data-open="true"]`, `getState().kind = 'aircraft'`, `selection = { layerId: 'flights', id: 'a06656' }`, `error = null` (flights row at that moment: `DEGRADED · adsb.lol`, 662 records) |
| Session id (last 6 chars shown in `#ondemand-entity-chat-status`) | `READY · session …0f4886 · last turn 5444 ms` (read from the DOM after the turn; the full id is never rendered) |
| Context turn latency (system line "Context loaded … in N ms") | not captured separately this pass — the driver read only the assistant message and the status line; the priming turn is included in the 6 s between `openFirstVisible` resolving (17:32:39Z) and `send()` resolving (17:32:45Z) together with the 5 444 ms answer turn |
| First-token latency (`#ondemand-entity-chat-latency[data-ms]`) | **2429 ms** — badge text `first token in 2429 ms`, `data-ms="2429"`, equal to `turn.firstTokenMs`; the turn resolved `{ firstTokenMs: 2429, totalMs: 5444, chars: 523, ok: true, error: null }` for the prompt "What is this aircraft doing and what else is near it?" |
| Assistant answer (excerpt) | "Live Flights is **DEGRADED** because OpenSky is unreachable; the aircraft data comes from the regional adsb.lol feed. N125AS is airborne at **1,326 m**, traveling at **57.9 m/s (113 kt)** on heading **288°**; its route, aircraft type, operator, and destination are **not reported**. Nearby aircraft include **N7823G** at **24.2 km**, **UAL1…**" (523 chars) |
| `X-OnDemand-Key-Source` on the chat response | `x-ondemand-key-source: server` — confirmed on the same proxy client with `POST /api/ondemand/sessions` (HTTP 201, 17:42:10Z); in the overlay `#ondemand-entity-chat-key-state` read **`server key`**, no `x-ondemand-key` request header was sent (no stored key), and the overlay text (846 chars) contained no key material |
| Screenshot | `.ui-proof/e2e-entity-chat-1440x900.png` (captured 17:32:48Z with the overlay open; Cesium render loop frozen for the capture) — after-only: there is no live "before" build of this preview |

Validator verdict for the run: `ok: true`, 0 page errors; the only console error was the benign
`GET /api/setup/status` 404 probe.

Headless recipe (browser console or a driver):

```js
const chat = window.__godsEyeView.entityChat;
await chat.openFirstVisible('aircraft');            // or click #ask-ondemand-btn after clicking a plane
document.querySelector('#ondemand-entity-chat-status').textContent;   // READY · … · session …abc123
const turn = await chat.send('What is this aircraft doing and what is near it?');
turn.firstTokenMs;                                  // === Number(document.querySelector('#ondemand-entity-chat-latency').dataset.ms)
```

Unit tests: `node --test src/ondemand/entityContext.test.mjs src/ondemand/entityChat.test.mjs src/ondemand/noKeyInBundle.test.mjs`
and `npm run test:ondemand` (includes `server/ondemand/key-override.test.mjs`).

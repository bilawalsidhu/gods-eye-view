# OnDemand camera chat — contract addendum (2026-09-21)

Addendum to `docs/ONDEMAND_QUICKFIRE_CHAT_CONTRACT_2026-09-19.md` (chat contract) and
`docs/ONDEMAND_API_CURRENT.md` (API reference). Scope: **ASK ONDEMAND on a live street
camera** — the CCTV panel's camera inset (e.g. Austin `336` "MARTIN LUTHER KING JR BLVD /
COMAL ST") gets a chat panel that can answer frame questions (vehicles, crosswalk, signals,
lane occupancy), lane/traffic questions and internet-connected questions.

Every OnDemand fact below was re-read from the **live** public docs on 2026-09-21 (§8);
nothing is answered from memory. Where the docs are silent the text says so.

## 1. What shipped (tree delta vs `8d2a900`)

| Area | Files | Behaviour |
|---|---|---|
| Chat panel | `src/ondemand/entityChat.js`, `src/ui/styles/ondemand-chat.css` | new entity kind **`camera`**; `openCamera({cameraId})`; ONE OnDemand session per camera, persisted in `localStorage` `ondemand.session.camera:<cameraId>`; history reload through cursor pagination on open; per-turn context refresh; lucide `image-plus` **attach-frame** control (composer, camera kind only); keyless → explicit *NOT CONFIGURED* state |
| Entity context | `src/ondemand/entityContext.js`, `src/ondemand/cameraContext.js` | `LAYER_KIND.cctv = 'camera'`; camera fields (id, intersection, streets, lat/lon, MGRS via scene block, heading + cardinal, FOV, pitch, range, provider, source health, frame `{url, capturedAtUtc, ageSec}`, `roads[]` from Overpass, `traffic` sample); analyst instruction lines for frame/lane/internet questions |
| Panel toggle | `src/ui/templates/layer-panels.html` (`#cctv-ask-btn`), `src/ui/cctvBindings.js`, `src/ui/cctvPresentation.js`, `src/ui/shellElements.js`, `src/ui/applicationShell.js`, `src/ui/styles/cctv.css`, `src/ui/cctvFrames.js` (`data-loaded-at`) | lucide `message-square` button in the CCTV panel, shown only with an active camera; dispatches `gev:ask-camera` → controller. Clear-layers (`layers-minus`) and share-link (`link`) buttons untouched; no new brand mark |
| Proxy | `api/ondemand/chat.js` | proxy-side fields `profile: "camera"` and `attachment: {mediaId}` (never forwarded): the profile fills `endpointId` / `pluginIds` / `reasoningMode` the body omitted from server config; an attachment selects the vision endpoint. Response headers `X-OnDemand-Profile`, `X-OnDemand-Profile-Applied` |
| Proxy | `api/ondemand/sessions.js` | `GET /api/ondemand/sessions?sessionId=&cursor=&limit=&sort=` → `GET {chat}/sessions/{id}/messages` (cursor pagination forwarded verbatim) |
| Proxy | `api/ondemand/media.js` | unchanged — the multipart raw upload (`{media}/raw`) is what the frame attach uses |
| Proxy | `api/ondemand/health.js` | new non-secret `cameraChat` block (ids, mode names, env **names**) |
| Config | `server/ondemand/camera-chat-config.js` (+ `api/ondemand/_config.js` re-export) | env-configurable camera defaults (§4) |
| Icons | `src/ui/icons/lucide-manifest.json`, `lucideIcons.generated.js`, `public/brand/icons/{message-square,image-plus}.svg` | two Lucide 1.47.0 icons added through `scripts/sync-lucide-icons.mjs` |
| Tests | `src/ondemand/cameraContext.test.mjs` (7), `src/ondemand/cameraChat.test.mjs` (8), `server/ondemand/camera-chat.test.mjs` (12) | session store/persistence, profile, media route, messages proxy, keyless 503s, lucide-only controls |
| Harness | `scripts/qa-chat-harness.mjs` (`npm run qa:chat -- --url <preview> --out <dir>`) | opens MLK/Comal, opens the panel, sends the three queries, logs every `/api/ondemand/*` call (URL, status, latency, UTC), PNG proofs |

**Function budget:** still **9** serverless functions (`api/[...route].js` + 8 under `api/ondemand/`); no new route file — history rides on `sessions.js`, upload on `media.js`, the profile on `chat.js`. Hobby cap 12.

## 2. Flow

```
CCTV panel  ─ ASK (lucide message-square) ─▶ gev:ask-camera ─▶ entityChat.openCamera()
   │ cameraContext.resolveCameraEntity(): active camera + frame + Overpass lanes + traffic sample
   │ stored session for camera:<id>?  yes ─▶ GET /api/ondemand/sessions?sessionId&limit&cursor… (history)
   │                                   no  ─▶ POST /api/ondemand/sessions  → POST /api/ondemand/chat {sync, profile:camera, query: instruction + CONTEXT_JSON}
   └ each turn: [attach? GET /api/cctv/frame/<id> → POST /api/ondemand/media (multipart, sessionId, plugins=image agent)]
                POST /api/ondemand/chat {stream, profile:camera, modelConfigs.fulfillmentPrompt: fresh context, attachment?} → SSE
```

The browser never sees `ONDEMAND_API_KEY`: every call is same-origin `/api/ondemand/*`; the
proxy adds the `apikey` header server-side (`server/ondemand/client.js`). Optional per-browser
key override (`x-ondemand-key`) is unchanged.

## 3. Entity context for a camera

`entitySystemPrompt(context)` (first turn) and `modelConfigs.fulfillmentPrompt` (every turn,
budget 12 KiB) carry:

```json
{ "schema": "ondemand-spatial/entity-chat/1", "entity": {
    "kind": "camera", "cameraId": "336", "name": "MARTIN LUTHER KING JR BLVD / COMAL ST",
    "streets": ["Martin Luther King Jr Blvd", "Comal St"], "lat": 30.279104, "lon": -97.725136,
    "headingDeg": 338, "headingCardinal": "N", "fovDeg": 44, "pitchDeg": -18, "rangeM": 145,
    "provider": "Austin Transportation & Public Works", "sourceStatus": "ok",
    "frame": { "url": "/api/cctv/frame/336?…", "capturedAtUtc": "2026-09-21T10:42:00.376Z", "ageSec": 4, "status": "shown" },
    "roads": [ { "osmWayId": 11, "name": "East Martin Luther King Jr Boulevard", "highway": "primary", "lanes": 4, "lanesForward": 2, "lanesBackward": 2, "maxspeed": "35 mph", "turnLanesForward": "left|through;right" } ],
    "traffic": { "layerEnabled": true, "mode": "live", "closedRoads": 0, "flowSegment": { "currentSpeed": 18, "freeFlowSpeed": 45 } } },
  "scene": { "coordinates": { "mgrs": "14R PU 2261 5040" } },
  "layers": [ { "id": "traffic", "label": "Street Traffic", "enabled": true, "statusText": "…" }, "… every DATA LAYERS row …" ] }
```

- **Lanes** — `roads[]` is `POST /api/overpass` (the existing traffic-layer proxy) with
  `way["highway"~…](around:60,<lat>,<lon>); out tags center;` — tags `name, highway, lanes,
  lanes:forward, lanes:backward, oneway, maxspeed, turn:lanes*`. The tree kept no lane tags
  before (the traffic layer stores only class + oneway), so this is the lane source. A failed
  lookup leaves `roads: null` and the instruction tells the model to say "not tagged".
- **Traffic / MOVEMENT state** — `traffic` is the Street Traffic layer's `getStats()`
  (mode live/sim, `flowSegment` speed sample, `closedRoads`, coverage); the toggles of every
  layer (Satellites, Live Flights, Military Flights, Live Vessels, Street Traffic, …) are the
  `layers[]` rows exactly as the DATA LAYERS panel shows them.
- **Frame timestamp** — `frame.capturedAtUtc` is the load time of the frame on screen
  (`#cctv-frame[data-loaded-at]`); the provider burns its own capture time into the picture.

## 4. Server configuration (all non-secret, read once at boot)

| Env | Default | Why |
|---|---|---|
| `ONDEMAND_API_KEY` | — | **required for any chat** (runtime-only, server-side; never shipped/logged). Keyless → every proxy route answers `503 not_configured`, health says `"configured": false`, the panel shows *NOT CONFIGURED* |
| `ONDEMAND_CAMERA_CHAT_ENDPOINT_ID` | `predefined-cerebras-qwen-3.8-27b` | text-only turns — the LIVE-verified Cerebras endpoint of the quick-fire contract (not in the docs' predefined table; overridable for that reason) |
| `ONDEMAND_CAMERA_CHAT_VISION_ENDPOINT_ID` | *(empty → same as text endpoint)* | turns with an attached frame. **The live docs publish no per-model vision/multimodal statement** (`docs/fulfillment-models`, 18 rows, 0 hits for vision/multimodal, 2026-09-21). Image understanding therefore uses the **documented** Media API path: the frame is uploaded with the image agent and linked to the session, and its extracted `context` is what the fulfillment model reads. Set this once a multimodal endpoint is confirmed for the account |
| `ONDEMAND_CAMERA_CHAT_PLUGIN_IDS` | `agent-1713924030` | comma list sent as `pluginIds` on every camera turn — the **Internet Agent** (`identifier: internet`) shown in the docs' stream sample (`docs/query-and-responses-modes`, statusLog `retrievedAgents`); the only web-search agent id the docs publish. `''` disables |
| `ONDEMAND_CAMERA_CHAT_REASONING_MODE` | `low` | stream-only `reasoningMode` (`docs/chat-api`: "e.g., low, high … Relevant only for responseMode: stream"); validated against `DOCUMENTED_REASONING_MODES`, invalid → `low` + `reasoningModeInvalid: true` |
| `ONDEMAND_CAMERA_CHAT_IMAGE_PLUGIN_ID` | `plugin-1713958591` | Media API `plugins` entry for png/jpg/jpeg — the image sample in `docs/media-api` |
| `ONDEMAND_CAMERA_CHAT_HISTORY_LIMIT` | `20` | history page size (docs: `limit` 1..50, default 10) |

`GET /api/ondemand/health` → `cameraChat: { endpointId, visionEndpointId, visionEndpointSource,
pluginIds, reasoningMode, reasoningModeInvalid, imagePluginId, historyLimit, env: {names}, sources }`.

## 5. Copy-pasteable calls

### 5.1 Create session (docs: `POST /chat/v1/sessions`, `externalUserId` required, `pluginIds` ≤ 20)

```bash
curl -sS -X POST https://api.on-demand.io/chat/v1/sessions \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" \
  -d '{"externalUserId":"ondemand-spatial-entity-2026-09-21","pluginIds":["agent-1713924030"]}'
# → { "message": "…", "data": { "id": "<sessionId>", "externalUserId": "…", "pluginIds": [...], "createdAt": "…" } }

# same-origin proxy (browser): the server key is added upstream, never in the page
curl -sS -X POST https://<preview>/api/ondemand/sessions -H "Content-Type: application/json" \
  -d '{"userId":"ondemand-spatial-entity-2026-09-21","reuse":false}'
# → 201 { "sessionId": "<sessionId>", "externalUserId": "…", "reused": false, "createdAt": "…" }   (503 not_configured when keyless)
```

```js
const session = await (await fetch('/api/ondemand/sessions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: 'ondemand-spatial-entity-2026-09-21', reuse: false }),
})).json(); // session.sessionId
```

### 5.2 Upload the camera frame (docs: `POST /media/v1/public/file/raw`, multipart; image types png/jpg/jpeg; `sessionId` links it to the chat)

```bash
curl -sS -X POST https://api.on-demand.io/media/v1/public/file/raw -H "apikey: $ONDEMAND_API_KEY" \
  -F 'file=@frame.jpg' -F 'name=336-2026-09-21T10-42-00Z.jpg' -F "sessionId=$SESSION_ID" \
  -F 'plugins=plugin-1713958591' -F 'sizeBytes=48213' -F 'responseMode=sync'
# → { "message": "Media Created", "data": { "id": "<mediaId>", "source": "image", "sessionId": "…", "actionStatus": "completed", "context": "…", "extractedText": "…" } }

# proxy: identical multipart body, forwarded verbatim to {media}/raw
curl -sS -X POST https://<preview>/api/ondemand/media -F 'file=@frame.jpg' -F 'name=frame.jpg' -F "sessionId=$SESSION_ID" -F 'plugins=plugin-1713958591' -F 'sizeBytes=48213' -F 'responseMode=sync'
```

```js
// exactly what src/ondemand/entityChat.js attachFrame() does
const blob = await (await fetch(document.getElementById('cctv-frame').dataset.currentSrc, { cache: 'no-store' })).blob();
const form = new FormData();
form.append('file', blob, 'frame.jpg'); form.append('name', 'frame.jpg'); form.append('sessionId', sessionId);
form.append('plugins', 'plugin-1713958591'); form.append('sizeBytes', String(blob.size)); form.append('responseMode', 'sync');
const media = await (await fetch('/api/ondemand/media', { method: 'POST', body: form })).json(); // media.data.id
```

### 5.3 Submit query — SSE stream with pluginIds / reasoningMode / attached frame (docs: `POST /chat/v1/sessions/{id}/query`, required `query, endpointId, responseMode`)

```bash
curl -N -sS -X POST "https://api.on-demand.io/chat/v1/sessions/$SESSION_ID/query" \
  -H "apikey: $ONDEMAND_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"Are there any vehicles or pedestrians in the crosswalk right now?","endpointId":"predefined-cerebras-qwen-3.8-27b","responseMode":"stream","pluginIds":["agent-1713924030"],"reasoningMode":"low","modelConfigs":{"fulfillmentPrompt":"<instruction + CONTEXT_JSON>"}}'
# event:message  data:{"eventType":"statusLog", "currentStatusLog":{"statusType":"executing","executedAgents":[{"agentId":"agent-1713924030","identifier":"internet"}]}}
# event:message  data:{"eventType":"fulfillment","answer":"Two","eventIndex":1}   … append answer chunks in eventIndex order
# event:message  data:{"eventType":"metricsLog","publicMetrics":{…}}
# event:message  data:[DONE]        (error: data:[ERROR]:{"message":"…","errorCode":"…"})

# proxy: profile fills endpointId/pluginIds/reasoningMode from server config; attachment names the media already linked to the session
curl -N -sS -X POST https://<preview>/api/ondemand/chat -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"sessionId":"'$SESSION_ID'","query":"Are there any vehicles or pedestrians in the crosswalk right now?","responseMode":"stream","profile":"camera","attachment":{"mediaId":"'$MEDIA_ID'"},"modelConfigs":{"fulfillmentPrompt":"<instruction + CONTEXT_JSON>"}}'
```

```js
const res = await fetch('/api/ondemand/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ sessionId, query, responseMode: 'stream', profile: 'camera', attachment: mediaId ? { mediaId } : undefined,
                         modelConfigs: { fulfillmentPrompt } }),
});
const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '', event = 'message', answer = '';
for (;;) { const { value, done } = await reader.read(); if (done) break; buf += decoder.decode(value, { stream: true });
  let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
    if (!line) { event = 'message'; continue; } if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
    if (!line.startsWith('data:')) continue; const data = line.slice(5).trim();
    if (data === '[DONE]') { reader.cancel(); break; } if (data.startsWith('[ERROR]')) throw new Error(data.slice(8));
    if (event === 'heartbeat' || event === 'thinking') continue;
    const frame = JSON.parse(data); if (frame.eventType === 'fulfillment') answer += frame.answer; } }
```

`createSseParser()` in `src/ondemand/entityChat.js` implements the same table (statusLog /
fulfillment / metricsLog / heartbeat / `[DONE]` / `[ERROR]:`) and is what the panel uses.

### 5.4 History — cursor-paginated messages (docs: `GET /chat/v1/sessions/{id}/messages`; `cursor` omitted on the first page, then `pagination.next`; empty string = end; `limit` 1..50 default 10; `sort` asc|desc)

```bash
curl -sS "https://api.on-demand.io/chat/v1/sessions/$SESSION_ID/messages?limit=20&sort=desc" -H "apikey: $ONDEMAND_API_KEY"
# → { "message": "…", "data": [ { "id": "…", "type": "text|media", "query": "…", "answer": "…", "media": {"id","name","source","url","context"}, "createdAt": "…" } ], "pagination": { "next": "<cursor|''>", "limit": 20 } }
curl -sS "https://api.on-demand.io/chat/v1/sessions/$SESSION_ID/messages?limit=20&sort=desc&cursor=$NEXT" -H "apikey: $ONDEMAND_API_KEY"

# proxy
curl -sS "https://<preview>/api/ondemand/sessions?sessionId=$SESSION_ID&limit=20&sort=desc[&cursor=$NEXT]"
```

```js
let cursor = null, pages = [];
do { const p = new URLSearchParams({ sessionId, limit: '20', sort: 'desc' }); if (cursor) p.set('cursor', cursor);
     const page = await (await fetch(`/api/ondemand/sessions?${p}`)).json(); pages.push(page); cursor = page.pagination?.next || ''; } while (cursor && pages.length < 3);
```

## 6. Harness

```
npm run qa:chat -- --url https://<preview> --out /tmp/chat   # or node scripts/qa-chat-harness.mjs …
```
Opens the Austin scene at MLK/Comal, enables CCTV, selects camera `336` by name (fallback:
nearest), waits for the frame, clicks `#cctv-ask-btn`, then sends
(i) *Are there any vehicles or pedestrians in the crosswalk right now?* (frame attached),
(ii) *How many lanes are on MLK here and which are open toward Comal?*,
(iii) *Any current road closures or incidents on MLK Jr Blvd in Austin right now?* —
asserting for each an SSE-streamed answer (`sseEventCount > 0`) **when the server holds a key**.
Every `/api/ondemand/*` call is logged twice (controller ledger + page network log) with
method, URL, HTTP status, latency and UTC time; PNGs: `chat-before-1440x900.png`,
`chat-open-1440x900.png`, `chat-open-crop.png`, `chat-after-1440x900.png`, `chat-after-crop.png`.
Structural assertions (panel opens, kind `camera`, lucide `message-square` / `image-plus` / `x`,
no emoji / Material ligature / brand mark inside the panel, header brand marks 1/1,
clear-layers = `layers-minus`, share = `link`) fail the process; a keyless deployment records
`configured: false` and the `503 not_configured` calls instead of answers.

## 7. Keyless behaviour (what the 2026-09-21 sandbox shows)

`GET /api/ondemand/health` → `"configured": false` (and the `cameraChat` block); the panel
prints *NOT CONFIGURED · ONDEMAND_API_KEY is not set on the server* plus the proxy's
`503 not_configured` line; no upstream call is made. To exercise the three queries the
deployment needs exactly one secret — **`ONDEMAND_API_KEY`** — set as a server environment
variable (the same variable `api/ondemand/health.js`, `chat.js`, `sessions.js`, `media.js` read).
Optional overrides are the `ONDEMAND_CAMERA_CHAT_*` names in §4. No other credential is
required by the live docs for chat, media upload or the Internet Agent.

## 8. Live docs read on 2026-09-21 (HTTP status, UTC)

| # | URL | HTTP | Retrieved (UTC) |
|---|---|---|---|
| 1 | https://gateway.on-demand.io/config/v1/public/docs/categories | 200 | 2026-09-21T10:11:15Z |
| 2 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createchatsession | 200 | 2026-09-21T10:11:24Z |
| 3 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatsessions | 200 | 2026-09-21T10:11:25Z |
| 4 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatsession | 200 | 2026-09-21T10:11:25Z |
| 5 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatmessages | 200 | 2026-09-21T10:11:25Z |
| 6 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/getchatmessage | 200 | 2026-09-21T10:11:26Z |
| 7 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/submitquery | 200 | 2026-09-21T10:11:26Z |
| 8 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/updatelivesessionsettings | 200 | 2026-09-21T10:11:27Z |
| 9 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/createmediaurl | 200 | 2026-09-21T10:11:27Z |
| 10 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/fetchmedia | 200 | 2026-09-21T10:11:28Z |
| 11 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/deletemedia | 200 | 2026-09-21T10:11:28Z |
| 12 | https://gateway.on-demand.io/config/v1/public/docs/reference/api/get_public-sessions | 200 | 2026-09-21T10:11:28Z |
| 13 | https://docs.on-demand.io/docs/fulfillment-models (updatedAt 2026-08-24T13:17:28Z) | 200 | 2026-09-21T10:11:51Z |
| 14 | https://docs.on-demand.io/docs/chat-api | 200 | 2026-09-21T10:11:58Z |
| 15 | https://docs.on-demand.io/docs/media-api | 200 | 2026-09-21T10:11:59Z |
| 16 | https://docs.on-demand.io/docs/plugin-api | 200 | 2026-09-21T10:12:00Z |
| 17 | https://docs.on-demand.io/docs/plugins | 200 | 2026-09-21T10:12:00Z |
| 18 | https://docs.on-demand.io/docs/what-are-plugins | 200 | 2026-09-21T10:12:01Z |
| 19 | https://docs.on-demand.io/docs/terminal-agent | 200 | 2026-09-21T10:12:02Z |
| 20 | https://docs.on-demand.io/docs/query-and-responses-modes | 200 | 2026-09-21T10:12:03Z |
| 21 | https://docs.on-demand.io/docs/authentication | 200 | 2026-09-21T10:12:04Z |
| 22 | https://docs.on-demand.io/docs/rate-limiting | 200 | 2026-09-21T10:12:04Z |
| 23 | https://docs.on-demand.io/docs/pagination | 200 | 2026-09-21T10:12:05Z |
| 24 | https://docs.on-demand.io/docs/what-are-chat-sessions | 200 | 2026-09-21T10:12:05Z |
| 25 | https://docs.on-demand.io/docs/agent-skills | 200 | 2026-09-21T10:12:06Z |
| 26 | https://docs.on-demand.io/docs/open-api-schema | 200 | 2026-09-21T10:12:07Z |
| 27 | https://docs.on-demand.io/docs/reasoning-modes | **404** | 2026-09-21T10:12:47Z |
| 28 | https://docs.on-demand.io/reference/submitquery | 200 | 2026-09-21T10:12:47Z |
| 29 | https://docs.on-demand.io/reference/createmediaraw | **404** | 2026-09-21T10:12:48Z |
| 30 | https://docs.on-demand.io/reference/rate-limits | 200 | 2026-09-21T10:12:57Z |
| 31 | https://docs.on-demand.io/reference/how-to-paginate | 200 | 2026-09-21T10:12:57Z |

### Cross-check vs the on-file contract (2026-09-17/19)

| Item | Status |
|---|---|
| `pluginIds` maxItems 20, replaces session plugins | CONFIRMED (#7) |
| `reasoningMode` guide-only, examples `low`/`high`, stream only | CONFIRMED (#14); NEW detail: the #20 cURL sample sends `"reasoningMode": "grok-4-fast"` |
| raw upload multipart `file, name, sessionId, plugins, sizeBytes, responseMode` (+ `createdBy`, `updatedBy`) | CONFIRMED (#15); no OpenAPI page (#29 404) |
| image sample plugin `plugin-1713958591`; file agents `plugin-1713961903/1713967141/1713954536/1713958830`; ingest `plugin-1716472791`; Terminal `plugin-1775547203` | CONFIRMED (#15, #9, #19) |
| stream sample `agent-1713924030` "Internet Agent" `identifier: internet` | CONFIRMED (#20) — used as the default `pluginIds` |
| predefined table 18 rows, `updatedAt 2026-08-24` | CONFIRMED (#13) |
| messages list cursor-paginated, `pagination.next` `''` at end, `limit` default 10 (max 50) | CONFIRMED (#5, #31) |
| media → session via `sessionId`, message `type: "media"` | CONFIRMED by schema (#9/#15 + #5); no step-by-step walkthrough in the docs |
| `contextMetadata` on REST create-session | CONFIRMED absent (#2, #14) |
| `predefined-cerebras-qwen-3.8-27b` in the docs | NOT FOUND (0 hits) — LIVE-only endpoint, kept configurable |
| vision / multimodal capability per endpoint | NOT FOUND (#13) — see §4 |
| REST endpoint listing reasoning modes | NOT FOUND (#1, #27) |
| `externalUserId` required | DISCREPANCY: OpenAPI `required` (#2) vs guide "Required: No" (#14) — the proxy always sends it |
| NEW operation | `PUT /chat/v1/sessions/{sessionId}/live-settings` (#8) — not used |
| Auth header | `apikey` (all specs); the auth guide's "Bearer" sentence contradicts its own samples |
| Rate limits | free plan "Media Upload Per Minute – 5", "RAG Calls Per Minute – 100"; 10,000 req/min per origin IP (#22, #30) |

# Camera sweep (local voice)

"Scan the cameras around downtown and tell me which streets are jammed."

The local voice assistant (`AI_PROVIDER=ollama`) can look through several
public cameras at once, ask the local vision model the same question about
each frame, and mark the map with the verdicts. It is a tool pack
(`src/voice/tools/cameraSweep.js`) plus one server route
(`server/providers/ollama/routes/visionBatch.js`); nothing in the core voice
loop changed.

## Saying it

| Say                                                             | What happens                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| "Scan the cameras around here and tell me which streets are jammed" | `camera_sweep` with `scope.kind = view`, question "Is traffic jammed or stopped?"           |
| "Check the eight nearest cameras for flooding"                  | `camera_sweep` with `max: 8`, `scope.kind = anywhere`                                       |
| "Is it raining at any camera within 5 km of the Capitol?"       | `camera_sweep` with `scope.kind = radius`, `latitude/longitude` of the Capitol, `km: 5`     |
| "Clear the camera marks"                                        | `clear_camera_marks` (clears the annotation board, same as `clear_annotations`)             |

The CCTV layer must be on ("turn on cameras"). A sweep of eight cameras takes
roughly 20-60 s on a single local GPU: frames arrive in parallel, then the
vision model looks at two frames at a time. The assistant says "Checking N
cameras." before the wait and then speaks the counts and the red cameras by
name.

## Tool arguments

```
camera_sweep {
  question: string,                 // yes/no style visual question, asked of every camera
  scope?: { kind: 'view' | 'radius' | 'anywhere', latitude?, longitude?, km? },
  max?: integer 1..12,              // cameras to check, nearest first (default 8)
  mark?: boolean                    // drop coloured marks (default true)
}
clear_camera_marks {}
```

`scope` follows the same rules as `data_report` / `watch_add`: `view` is a
radius derived from the camera altitude, `radius` without a point means "around
the current camera position", `anywhere` is the nearest loaded cameras
regardless of what is on screen.

## What the tool does

1. **Cameras** come from the CCTV layer module's public UI state:
   `window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState().cameras`
   (id, name, city, lat, lon, heading/fov/pitch, `sourceKind`, `sourceStatus`).
   If that surface is missing it falls back to `getDetectableObjects()` and
   converts the ECEF positions with the viewer ellipsoid. Cameras are ranked by
   distance from the scope centre; known placeholder feeds (`synthetic`,
   `offline`) sort last.
2. **Frames** are fetched in parallel from the same-origin proxy the projection
   plane already uses: `GET /api/cctv/frame/:id?label&city&lat&lon&heading&fov&pitch&ts&sweep=1`
   (`server/providers/cctv.js`, which calls `fetchCctvImageFromUpstream` or the
   TxDOT snapshot fetcher, then Street View, then a synthetic SVG). A response
   with `X-CCTV-Source: synthetic` or an SVG body is treated as "no live frame"
   and skipped; up to four spare cameras are fetched to fill failures. Each
   frame is decoded with `createImageBitmap`, drawn to a canvas at most 640 px
   wide and re-encoded as JPEG (quality 0.7, re-encoded smaller if it is still
   over 300 KB), then sent as base64 without the data-URL prefix.
3. **Vision** — one POST to `/api/voice/vision-batch` with all frames.
4. **Marks** — one `annotate_map` action (through the action runner when the
   session provides one, otherwise the annotation engine directly) with a `pin`
   per camera: **red** for score >= 0.6, **green** for <= 0.4, **amber**
   between; the label is `"<camera name>: <short answer>"`. Marks accumulate
   like every other voice annotation; `clear_camera_marks` wipes the board.

The handler returns a compact object for the model to speak:

```
{ ok, question, checked, inScope,
  counts: { red, amber, green },
  red: [{ label, answer, score }],
  cameras: [{ label, verdict, score, answer, distanceKm }],
  skipped: [{ id, label, reason }],
  marked, summary }
```

## Route: `POST /api/voice/vision-batch`

Installed by `server/providers/ollama/routes/index.js` when
`AI_PROVIDER=ollama`.

Request:

```json
{
  "question": "Is traffic jammed or stopped?",
  "images": [
    { "id": "354", "label": "5TH ST / CONGRESS AVE", "lat": 30.267, "lon": -97.743, "image": "<base64 jpeg>" }
  ]
}
```

Response:

```json
{
  "ok": true,
  "question": "...",
  "model": "qwen3-vl:4b",
  "results": [
    { "id": "354", "label": "...", "lat": 30.267, "lon": -97.743, "answer": "Light traffic, lanes moving.", "score": 0.1, "ms": 4200 }
  ],
  "summary": { "high": ["ids with score >= 0.6"], "low": ["ids with score <= 0.4"] },
  "dropped": [{ "id": "...", "label": "...", "reason": "image larger than 300 KB" }],
  "ms": 12000
}
```

Limits: 12 images per call, 300 KB per image (decoded), 6 MB body, question
truncated to 400 characters. Frames are analysed two at a time with a 40 s
per-image timeout; a frame that fails or times out is kept in `results` with
`score: 0.5` and an `error`, so one bad camera never sinks the sweep. Each
frame goes to `OLLAMA_VISION_MODEL` (default `qwen3-vl:4b`) through the same
`streamChat` helper as `ask_about_view`, with `think: 'omit'`, `num_ctx 4096`,
`num_predict 512`, `temperature 0.1`. The budget is larger than the 20-word
answer needs because qwen3-vl always reasons first (150-300 tokens per frame,
kept in `message.thinking`) and that reasoning counts against `num_predict`;
at 160 the content came back empty. The prompt asks for at most 20 words and
a final `SCORE: 0.x` line; the score is parsed from the last such line
(percentages and out-of-10 values are tolerated, missing means 0.5). Measured
on an RTX-class local GPU: 2-7 s per 640 px frame once the model is warm.

## Checking it

- `node --test src/voice/tools/visionBatch.test.mjs src/voice/tools/cameraSweep.test.mjs`
  covers score parsing, caps, concurrency, timeouts and the handler with a fake
  `streamChat`; and camera selection by distance, frame skipping, the batch
  POST and the annotate calls with a fake globe and fetch.
- Live: with the dev server running and the CCTV layer on, say "scan the
  cameras near here for heavy traffic", or from the console
  `await window.__gevVoice?.runTool?.('camera_sweep', { question: 'Is traffic heavy?', max: 4 })`
  where the session exposes it.

## Limits

- The vision model sees each frame alone and has no notion of "normal" for a
  camera, so "jammed" is judged from one still: a red light with a full stop
  line can read as a jam. Ask concrete questions ("stopped cars filling every
  lane", "standing water on the road").
- Cameras whose upstream is down fall back to Street View on the server; those
  frames are analysed (they are real imagery) but they are not live. The
  per-camera `frameSource` is kept internally; the spoken summary does not
  distinguish them.
- One sweep is one GPU queue: a voice turn spoken during the sweep waits
  behind the remaining frames.

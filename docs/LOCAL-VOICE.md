# Local voice (AI_PROVIDER=ollama)

Everything runs on this machine: no key leaves it and nothing is billed.

```
browser                              dev server (Node)                 workers
────────────────────────             ───────────────────────────────    ───────────────────────────
Silero VAD (WASM)  ──WAV/16 kHz──▶   /api/voice/ws                     scripts/local_audio.py
                                       ├─ transcribe ────────────────▶   faster-whisper (CUDA/CPU)
                                       ├─ Ollama /api/chat (tools) ──▶   qwen3:8b (OLLAMA_VOICE_MODEL)
                                       ├─ tool_call ◀──▶ tool_result     (runs in the browser)
                                       ├─ ask_about_view ────────────▶   qwen3-vl:4b (OLLAMA_VISION_MODEL)
                                       └─ sentences ─────────────────▶   Piper (per-language voices)
Web Audio playback  ◀──PCM chunks──
```

Start it with `scripts\dev-local.ps1` (Windows) or `scripts/dev-local.sh`. The
launcher waits for the Ollama tray app, pre-warms the audio worker and the tool
model, and opens the browser. A logon Scheduled Task named "GodsEyeView Local"
does the same at sign-in.

## Talking to it

Click **MIC** once. Speak, pause, and it answers; keep talking for more
commands. Tap MIC again to stop. With `PICOVOICE_ACCESS_KEY` set, saying the
wake word (default "Computer") starts a session hands-free.

The mic panel shows the last heard sentence and the reply. Replies are spoken
in the language you used (English, Spanish, French, German, Italian,
Portuguese have dedicated Piper voices; others fall back to the English voice).

## What it can do beyond the shared tools

The 28 upstream tools (fly, layers, tracking, styles, annotations, analyst
queries, ...) work unchanged. The local path adds 42 more (70 in total, about
14.5k prompt tokens), served by the browser adapter (`src/voice/localTools.js`)
and the packs in `src/voice/tools/`:

| Say | Tool | Notes |
| --- | --- | --- |
| "Remember this place as home" | `remember_place` | Deterministic, no model round trip. Saved in localStorage. |
| "Take me home" / "back to the office" | `go_to_saved_place` | Loose name matching. |
| "What places have I saved?" / "Forget the office" | `list_saved_places`, `forget_place` | |
| "That ship from yesterday" | `recall_recent_target` | Recent fly-to and tracked targets survive reloads. |
| "What does that sign say?" / "Is that a tanker?" / "Describe what you see" | `ask_about_view` | Screenshot to the vision model; the answer is spoken directly. |
| "Which airlines are over Texas?" / "Busiest camera cluster in Europe" / "Average altitude in view" | `data_report` | Grouping and count/avg/min/max/sum over loaded layers; CCTV density by 1° cell. |
| "Tell me when a plane comes within 20 km of here" / "Alert me on quakes over magnitude 5" | `watch_add` | Standing alerts, persisted; spoken unprompted when a new record matches. |
| "What alerts do I have?" / "Clear my alerts" | `watch_list`, `watch_clear` | |
| "Rewind ten minutes" / "Back to live" | `rewind_time`, `resume_live` | Drives the time-travel replay (see docs/TIME-TRAVEL.md). |
| "Listen to this station" / "Listen to BBC World Service" / "What did they just say?" / "Did they mention the highway?" | `radio_listen`, `radio_transcript`, `radio_search`, `radio_stop` | Server-side ffmpeg + Whisper on a live stream; one hour of transcript per station (see docs/RADIO-LISTEN.md). |
| "Scan the cameras downtown and tell me which streets are jammed" / "Clear the camera marks" | `camera_sweep`, `clear_camera_marks` | Frames from the nearest CCTV cameras go to the vision model in one batch; red/amber/green pins per camera (see docs/CAMERA-SWEEP.md). |
| "This is Anthony" / "Who am I?" / "Forget Anthony's voice" | `enroll_voice`, `who_is_speaking`, `list_voices`, `forget_voice` | Voice prints on the server; later transcripts are tagged `HEARD (Anthony):` (see docs/SPEAKER-ID.md). |
| "Make me a 60-second tour of the busiest airspace" / "Stop the tour" / "Save that tour as Texas rush" | `make_tour`, `stop_tour`, `save_tour` | Auto-Director: builds, plays and narrates a Director scene from live records (see docs/AUTO-DIRECTOR.md). |
| "Patrol this area for aircraft and brief me every ten minutes" / "Brief me on the Gulf patrol" / "Stop all patrols" | `patrol_start`, `patrol_brief`, `patrol_list`, `patrol_stop` | Standing missions re-check a scope on a schedule and speak what changed (arrivals, departures, stopped ships, sharp climbs/descents). Up to 6, persisted. |
| "Anything unusual going on?" / "Any ships gone dark?" / "Stop announcing anomalies" | `anomaly_list`, `anomaly_alerts` | Rule engine over the position history: stopped vessels, rapid descents, orbiting, impossible jumps, went dark. Only anomalies near the camera are spoken, at most 6 per 10 minutes. |
| "Draw a fence 40 km around here, count aircraft, alert me when one enters" / "How many entered the harbor fence this hour?" | `geofence_add`, `geofence_report`, `geofence_list`, `geofence_remove` | View box, circle or polygon; per-hour entered/exited counts; drawn on the map. |
| "Show me five minutes ahead" / "Which flights will be within 50 km of here in ten minutes?" | `predict_positions`, `who_will_be_near` | Dead reckoning from the history buffer; the scrubber shows `LIVE +MM:SS` and points fade with confidence (see docs/TIME-TRAVEL.md). |
| "Save this incident as harbor stop" / "What incidents do I have?" | `export_incident`, `list_incidents` | One self-contained HTML evidence bundle: screenshot, track replay, timeline, transcript, alerts (see docs/INCIDENTS.md). |
| "Share this place with the other globes" / "Who is connected?" / "Stop sharing alerts" | `share_place`, `peers_list`, `share_alerts` | Federation over `GEV_PEERS`; peer alerts are spoken as "From <peer>: ..." and shared places land in memory (see docs/FEDERATION.md). |

Fast paths: a bare "fly to <Austin, SF, NYC, Tokyo, London, Paris, Dubai, DC>"
and "remember this place as X" skip the model entirely (about 300 ms).

## Alerts

`src/voice/watchEngine.js` subscribes to `dataManager.subscribeActivity` and
re-evaluates every watch when its layer publishes a snapshot (flights poll
every 30 s). A record raises an alert the first time it matches; "view" and
"here" scopes are frozen to the camera position at creation. While a voice
session is open the alert is spoken through it; otherwise it appears as a toast
and browser speech. At most 12 watches, one alert every 4 s.

## Models and settings

| Setting | Default | Why |
| --- | --- | --- |
| `OLLAMA_VOICE_MODEL` | `qwen3:8b` | 11/12 on `npm run qa:tool-calls`, 300 ms median |
| `OLLAMA_VISION_MODEL` | `qwen3-vl:4b` | fits beside the tool model; ~1.5 s warm answer |
| `OLLAMA_NUM_CTX` | `24576` | prompt + 70 tools is ~14.5k tokens; HUD uses the same value so Ollama never reloads |
| `WHISPER_MODEL` / `WHISPER_DEVICE` | `large-v3-turbo` / `auto` | ~120 ms on CUDA; auto falls back to CPU (use `small` there) |
| `WHISPER_LANGUAGE` | `auto` | detected language drives the reply language and voice |
| `TTS_VOICE`, `TTS_VOICE_<LANG>` | `en_US-ryan-high`, per-language defaults | voices live in `.local/voices` |
| `PICOVOICE_ACCESS_KEY`, `WAKE_WORD` | unset | wake word is off until a key is present |
| `SPEAKER_MODEL` | `.local/models/wespeaker_en_voxceleb_CAM++.onnx` | `npm run speaker:fetch` downloads it (29 MB, Apache-2.0); speaker identity is off without it |

On the Ollama service: `OLLAMA_MAX_LOADED_MODELS=2`, `OLLAMA_KEEP_ALIVE=30m`,
`OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_CONTEXT_LENGTH=24576`.

## Checking it

- `npm run qa:local-voice` sends a spoken fixture over the WebSocket and expects
  transcript, tool call, reply and audio. `--fixture` and `--expect-tool a,b`
  select other cases.
- `npm run qa:tool-calls --models a,b` scores tool accuracy and latency.
- `.venv-local\Scripts\python scripts\bench_stt.py` benchmarks Whisper configs.
- `.venv-local\Scripts\python scripts\speaker_selftest.py` checks the speaker
  fbank and that Piper voices are told apart at the identity threshold.
- `.gev-logs/local-voice.jsonl` (server) and `.gev-logs/realtime-conversations.jsonl`
  (browser adapter) record every turn.

## Limits

- Turn-based: it answers after you pause, and pauses the mic while speaking.
- Vision sees only what is on screen at the moment of the question.
- Alerts run only while the app tab is open.
- Memory and watches are per browser profile (localStorage); voice profiles
  are per machine (`.gev-cache/voice-profiles.json`).

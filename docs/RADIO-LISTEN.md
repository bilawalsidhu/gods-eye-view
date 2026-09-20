# Radio in the loop (local voice)

The local voice assistant (`AI_PROVIDER=ollama`) can listen to a live radio
station and answer questions about what was said. Nothing leaves the machine:
ffmpeg pulls the broadcaster stream on the dev server, the same faster-whisper
worker that hears you transcribes it, and the text sits in memory for an hour.

```
browser (tool pack)                 dev server                          worker
──────────────────────────          ─────────────────────────────────   ─────────────────
radio_listen {station?}  ──POST──▶  /api/voice/radio {op:'start'}
   station = Radio layer's           ffmpeg -i <stream> → s16le 16 kHz
   playing station, or a             ├─ 15 s slices (480 000 bytes)
   directory search by name          ├─ WAV wrap → transcribe ────────▶ faster-whisper
radio_transcript {minutes} ──────▶   └─ ring of {t, text, language}, 60 min
radio_search {query, minutes}
radio_stop
```

## Requirements

- **ffmpeg** on the server machine. It is found in this order:
  1. `FFMPEG_PATH` (full path to the binary; an explicit path that does not
     exist is an error, not a fallback),
  2. `ffmpeg` / `ffmpeg.exe` on `PATH`,
  3. on Windows, the winget install that is not on `PATH` by default:
     `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\ffmpeg.exe`
     (newest build wins). Install with `winget install Gyan.FFmpeg`.
  Without it `radio_listen` returns HTTP 501 with that instruction.
- The local audio worker (`scripts/local_audio.py`, see docs/LOCAL-VOICE.md);
  radio slices share it with your own utterances, one transcription at a time.

## Saying it

| Say | What happens |
| --- | --- |
| "Listen to this station" (a station is playing in the Radio layer) | `radio_listen` with no argument: the playing station's stream is transcribed. A selected-but-stopped station is used as a fallback. |
| "Listen to BBC World Service" / "Listen to KUT in Austin" | `radio_listen {station}`: the loaded radio directory (`/api/radio/stations`, the same catalog the Radio layer shows) is searched by name, then place and tags. |
| "What did they just say?" / "Summarize the last ten minutes" | `radio_transcript {minutes}`; the model summarizes the timestamped lines. |
| "Did they mention the highway?" | `radio_search {query, minutes}` returns matching lines. |
| "Stop listening" | `radio_stop`. The transcript stays readable until the ring ages out. |

The first slice takes about 20 s (15 s of audio plus transcription). Listening
does not start or stop playback in the browser; the two are independent.

## Route

`POST /api/voice/radio` with a JSON body (`GET` returns `status`):

| op | body | returns |
| --- | --- | --- |
| `start` | `url`, `label` | `{id, label, url, startedAt, ...}`; a URL already being transcribed returns `alreadyListening: true` |
| `stop` | `id?` | `{stopped: [ids], listening: [...]}`; no `id` stops every listener |
| `status` | | `{ffmpeg, listening: [...], recent: [...]}` with chunk/transcribed/dropped counters |
| `transcript` | `id?`, `minutes` (default 5, max 60) | `{lines: [{t, text, language}], text: "[HH:MM:SS] ..."}` |
| `search` | `id?`, `query`, `minutes` (default 30) | matching lines in the same shape |

Without `id`, the most recent live listener is used, then the most recent
ended one.

## Where transcripts live

In process memory only: one ring per listener holding `{t, text, language}`
lines for the last 60 minutes. They are not written to disk and are gone when
the dev server restarts. Start/stop and transcription errors are appended to
`.gev-logs/local-voice.jsonl` like the rest of the local voice path (URLs and
labels, never transcript text).

## Limits and safety

- At most **2 concurrent listeners**; a third `start` returns 409.
- Each listener stops itself after **60 minutes** or when ffmpeg exits (stream
  dropped, unsupported codec, network error); the reason is in `status.recent`.
- Slices are transcribed one at a time per listener. If Whisper falls behind,
  at most 2 slices wait; older ones are **dropped** (counted in `status`), so a
  slow CPU-only Whisper yields a sampled transcript rather than a growing lag.
- Only public `http(s)` hosts are accepted: loopback, private, link-local,
  `.local`/`.internal` names, literal IPv6 hosts and URLs with credentials are
  refused before spawning, and the host is resolved with the same address
  policy the radio directory proxy uses (`resolveRadioProxyAddresses`). ffmpeg
  performs its own lookup afterwards, so this is not a defence against DNS
  rebinding; the listener is meant for directory stations.
- Whisper runs with language auto-detection per slice; music-only slices
  usually come back as `noSpeech` and are skipped.
- Line timestamps are approximate: a slice is stamped 15 s before it finished
  arriving. Broadcasters buffer 5 to 30 s behind live and burst that buffer on
  connect, so the first lines can carry times slightly before `radio_listen`
  was called.
- Tests (`src/tooling/radioListen.test.mjs`) use a fake ffmpeg and a fake
  worker; no network or binary is needed.

## Files

- `server/providers/ollama/radio.js`: ffmpeg resolution, chunker, WAV
  wrapper, transcript ring, listener manager.
- `server/providers/ollama/routes/radio.js`: the `/api/voice/radio` route.
- `src/voice/tools/radio.js`: the tool pack (schemas + browser handlers).

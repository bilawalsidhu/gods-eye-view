# Recorder and replay

The recorder saves aircraft, military and vessel positions that pass through
this server to a local SQLite file, so you can replay them on the globe.
It is off by default. Recordings stay on your machine: the history API answers
loopback requests only, and nothing is shared. Several feeds (OpenSky,
AISStream) restrict storing or redistributing their data, so keep recordings
private.

## Turn it on

```
GEV_RECORDER=1 npm run dev
```

| Variable           | Default               | Meaning                          |
| ------------------ | --------------------- | -------------------------------- |
| `GEV_RECORDER`     | off                   | Set to `1` to record             |
| `GEV_HISTORY_FILE` | `data/history.sqlite` | Where the database lives         |
| `GEV_HISTORY_DAYS` | `7`                   | Days kept; `0` keeps everything  |

Positions are recorded only while the app is open and polling, and only for
times the server was running with the recorder on. Aircraft are captured from
the `/api/flights` and `/api/military` responses; vessels are sampled from the
AIS store every 30 s. A point is kept when 30 s have passed and the contact
moved 25 m or turned 10°.

## Replay panel

When history exists, a REPLAY panel appears on the right rail. REPLAY loads
the newest six hours, switches the live aircraft, military and vessel layers
off, and moves the slider's time onto the globe. Play and the 1×/10×/100×
chips run it; AIR, MIL and SEA choose layers; Latest returns to live.

## History API (loopback only)

- `GET /api/history/range` — earliest and latest recorded time (epoch s).
- `GET /api/history/window?from&to&bbox=west,south,east,north&layers=air,mil,vessel`
- `GET /api/history/track/:id?from&to` — one contact's path.
- `GET /api/history/at?to=<epoch s>&bbox&layers` — last position of each
  contact within 10 minutes before `to`.

The MCP server adds `history_window`, `history_track` and `replay_to`, which
call these routes. Code lives in `server/recorder/`, `src/replay/` and
`src/ui/replayPanel.js`.

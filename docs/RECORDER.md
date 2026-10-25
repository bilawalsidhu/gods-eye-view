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

| Variable           | Default               | Meaning                         |
| ------------------ | --------------------- | ------------------------------- |
| `GEV_RECORDER`     | off                   | Set to `1` to record            |
| `GEV_HISTORY_FILE` | `data/history.sqlite` | Where the database lives        |
| `GEV_HISTORY_DAYS` | `7`                   | Days kept; `0` keeps everything |

Positions are recorded only while the app is open and polling, and only for
times the server was running with the recorder on. Aircraft are captured from
the `/api/flights` and `/api/military` responses; vessels are sampled from the
AIS store every 30 s. A point is kept when 30 s have passed and the contact
moved 25 m or turned 10°.

## Replay panel

When history exists, a REPLAY panel appears on the right rail. Its status line
shows how many positions are recorded and how long they are kept. The 1h, 6h
and 24h chips choose how much of the newest history REPLAY loads (six hours by
default); FIT flies the camera to the replayed contacts; clicking a contact
follows it. REPLAY switches the live aircraft, military and vessel layers
off, and moves the slider's time onto the globe. Play and the 1×/10×/100×
chips run it; AIR, MIL and SEA choose layers; Latest returns to live.

## Local receivers

If you run your own ADS-B receivers (`LOCAL_RECEIVER_FEEDS`, see
[LOCAL-RECEIVERS.md](LOCAL-RECEIVERS.md)), their aircraft are recorded on a
`local` layer and replay with the LOCAL chip. They are your own data, so they
are the best candidate for long recordings.

## Watched areas (geofences)

A fence is a named box that logs an event when a recorded contact enters or
leaves it. Only positions newer than the fence count, so a new fence does not
report everything already inside. Fences and events live in the same database,
and the panel lists the newest events. Press WATCH in the panel and drag a box on the globe to add one (Esc cancels); each fence shows as a dashed box on the map and in a list where ✕ removes it. You can also manage them through the MCP tools
`geofence_add`, `geofence_list`, `geofence_events` and `geofence_remove`, or the
routes below. Changing fences needs a JSON request from this origin, which stops
other web pages from editing them.

## History API (loopback only)

- `GET /api/history/status` — range plus position count, retention days and file size.
- `GET /api/history/range` — earliest and latest recorded time (epoch s).
- `GET /api/history/window?from&to&bbox=west,south,east,north&layers=air,mil,vessel,local`
- `GET /api/history/track/:id?from&to` — one contact's path.
- `GET|POST /api/history/fences`, `DELETE /api/history/fences/:id` — watched areas.
- `GET /api/history/events?since&fence&limit` — enter and exit events, newest first.
- `GET /api/history/at?to=<epoch s>&bbox&layers` — last position of each
  contact within 10 minutes before `to`.

The MCP server adds `history_window`, `history_track` and `replay_to`, which
call these routes. Code lives in `server/recorder/`, `src/replay/` and
`src/ui/replayPanel.js`.

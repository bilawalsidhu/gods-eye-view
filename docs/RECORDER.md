# Recorder and replay

The recorder saves aircraft, military and vessel positions that pass through
this server, so you can replay them on the globe later. **It is optional and
off by default.** God's Eye View works exactly as before without it, and you
do not need to install or set up anything to keep using the live globe.

Recordings stay on your machine: the history API answers loopback requests
only, and nothing is shared. Some feeds restrict storing their data. Read
[RECORDING-DATA-TERMS.md](RECORDING-DATA-TERMS.md) before you turn it on.

## Quick start (about two minutes)

You need Node 24 and a normal God's Eye View checkout. That is all: the
default storage is a SQLite file, which is built into Node. No database
server, no extra packages.

1. Copy the example settings file and keep the defaults:

   ```
   copy recorder.config.example.json recorder.config.json      (Windows)
   cp recorder.config.example.json recorder.config.json        (Mac, Linux)
   ```

   This is the only file you edit. It is already in `.gitignore`.

2. Start the app as usual:

   ```
   npm run dev
   ```

   The terminal prints `[gev-recorder] recording to ...` when it is on.

3. Leave it running for a few minutes, then reload the page. A REPLAY panel
   appears on the right rail once something has been recorded.

No file, no recording: delete `recorder.config.json` (or set `"enabled": false`)
and the app is back to live only. Setting `GEV_RECORDER=1` still works as a
one-off switch without a file.

## The settings file

`recorder.config.json` in the project folder (or the path in
`GEV_RECORDER_CONFIG`). Every line is optional; leave out what you do not need.

```json
{
  "enabled": true,
  "retention": "7d",
  "maxMb": 0,
  "layers": ["air", "mil", "vessel", "local"],
  "interval": 30,
  "database": "",
  "file": "data/history.sqlite"
}
```

| Setting     | Default               | Meaning                                                               |
| ----------- | --------------------- | --------------------------------------------------------------------- |
| `enabled`   | `false`               | `true` turns recording on                                             |
| `retention` | `"7d"`                | How long to keep: `6h`, `14d`, `8w`, `3m`, `1y`; `0` keeps everything |
| `maxMb`     | off (`0`)             | Size cap; the oldest positions are dropped to stay under it           |
| `layers`    | all                   | Which to record: `air`, `mil`, `vessel`, `local`                      |
| `interval`  | `30`                  | Minimum seconds between saved points for one contact                  |
| `file`      | `data/history.sqlite` | Where the SQLite file lives                                           |
| `database`  | off                   | Advanced: a `postgres://` address (see below)                         |

Environment variables do the same job and win over the file:
`GEV_RECORDER` (`1` or `0`), `GEV_HISTORY_RETENTION` (older form
`GEV_HISTORY_DAYS`), `GEV_HISTORY_MAX_MB`, `GEV_RECORDER_LAYERS` (comma list),
`GEV_RECORDER_INTERVAL`, `GEV_HISTORY_FILE`, `GEV_HISTORY_DB`.

Positions are recorded only while the app is open and polling. Aircraft are
captured from the `/api/flights` and `/api/military` responses; vessels are
sampled from the AIS store every 30 s. A point is kept when the interval has
passed and the contact moved 25 m or turned 10°.

## Advanced: PostgreSQL and PostGIS (not needed for normal use)

Most people should stay on the default SQLite file. Use PostgreSQL only if you
already run a server, want several tools to read the data, or expect very
large recordings.

1. Have a PostgreSQL 12 or newer database that only this app can reach.
   PostGIS is optional: if it is installed, area queries use it.
2. In the God's Eye View folder, run `npm install pg` once.
3. Put the address in the settings file, for example
   `"database": "postgres://user:password@127.0.0.1:5432/gev"`, or set
   `GEV_HISTORY_DB`.

The tables are created on first use. Retention, the size cap (measured as the
positions table size), pins, watched areas and export work the same as on
SQLite. If `pg` is not installed the history API says so. The settings file
holds the password in plain text, so keep it out of git (it is ignored by
default) and out of shared folders.

## Replay panel

When history exists, a REPLAY panel appears on the right rail. Its status line
shows how many positions are recorded and how long they are kept. The 1h, 6h
and 24h chips choose how much of the newest history REPLAY loads (six hours by
default); FIT flies the camera to the replayed contacts; clicking a contact
follows it. REPLAY switches the live aircraft, military and vessel layers
off, and moves the slider's time onto the globe. Play and the 0.5× to 60×
chips run it; CSV, GEOJSON, GPX and JSON download what is shown; `● REC` in the header shows the recorder is on; AIR, MIL and SEA choose layers; Latest returns to live.

Pick a UTC date and time and press JUMP to replay from that moment (the window
length still comes from 1h, 6h or 24h). REGION lets you drag a box on the
globe so only contacts inside it are replayed; press it again to clear. Type a
callsign, hex code or MMSI into the search box and press FIND to draw that
contact's whole recorded path in gold, with FIRST and LAST markers and any gap
of more than five minutes as a red dashed line; the summary line gives its
point count, first and last times and gap count.

PIN (shown after a search) keeps that contact's history past the retention
period and the size cap, until you press it again. Pins are also available at
`GET|POST /api/history/pins` and `DELETE /api/history/pins/:id`.

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
- `GET /api/history/track/:id?from&to` — one contact's path, with its first and last point and the gaps (over 5 minutes) with no observations.
- `GET /api/history/export?format=csv|geojson|gpx|json&from&to&bbox&layers&id` — download recorded points (one contact with `id`). The panel's CSV, GEOJSON, GPX and JSON chips download the current window.
- `GET|POST /api/history/fences`, `DELETE /api/history/fences/:id` — watched areas.
- `GET /api/history/events?since&fence&limit` — enter and exit events, newest first.
- `GET /api/history/at?to=<epoch s>&bbox&layers` — last position of each
  contact within 10 minutes before `to`.

The MCP server adds `history_window`, `history_track` and `replay_to`, which
call these routes. Code lives in `server/recorder/`, `src/replay/` and
`src/ui/replayPanel.js`.

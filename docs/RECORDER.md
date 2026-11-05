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
  "satelliteGroups": ["stations", "visual"],
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
| `layers`    | all                   | Which to record: `air`, `mil`, `vessel`, `local`, and `sat` (off unless named) |
| `satelliteGroups` | `stations`, `visual`, `gps-ops`, `galileo` | CelesTrak groups to record when `sat` is on |
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
chips run it; CSV, GEOJSON, GPX and JSON download what is shown; `● REC` in the header shows the recorder is on; AIR, MIL, SEA, LOCAL and SAT choose layers; Latest returns to live.

**Storage bar.** Under the status line, a bar shows how full the recording is:
green below 60%, orange from 60%, red from 85%. It is measured against the size
cap (`maxMb`) when one is set, otherwise against the disk (what is stored plus
what is free). Under it are the size used and free, a projection from the
growth so far ("Settles near 1.6 GB at this rate", or "Full in about 2d at this
rate" when the retention period would not fit), and the saved positions per
layer. In the red a warning says what happens next: with a cap the oldest
positions are being dropped; without one, lower the retention or set a cap.
With PostgreSQL the disk is not measured, so only the size and the per-layer
counts show unless a cap is set. The same numbers are in `/api/history/status`
(`bytes`, `max_bytes`, `disk_free_bytes`, `layer_counts`).

A solid dot on the globe is a recorded position; a faint ring is an
estimate between two recordings (within 15 s of a recording it shows solid).
Stretches where nothing was recorded for more than five minutes are not
drawn, so a contact disappears there instead of being shown to fly straight
across the gap.

Pick a UTC date and time and press JUMP to replay from that moment (the window
length still comes from 1h, 6h or 24h). REGION lets you drag a box on the
globe so only contacts inside it are replayed; press it again to clear. Type a
callsign, ship name, satellite name, hex code or MMSI (part of one is enough,
upper or lower case) into the search box and press FIND to draw that
contact's whole recorded path in gold, with FIRST and LAST markers and any gap
of more than five minutes as a red dashed line; the summary line gives its
name, point count, first and last times and gap count. When several contacts
match, the best one is shown (an exact match, then one that starts with what you
typed, then the most recently seen). Names are saved as they arrive: the
callsign from OpenSky, adsb.lol and your own receivers, the name from AIS, and
the satellite name from its orbital elements. A contact with no name can still
be found by its hex code or MMSI.

PIN (shown after a search) keeps that contact's history past the retention
period and the size cap, until you press it again. Pins are also available at
`GET|POST /api/history/pins` and `DELETE /api/history/pins/:id`.

## Satellites (opt-in)

The browser works out satellite positions itself, so the recorder repeats the
sums on the server from the same CelesTrak orbital elements. Add `"sat"` to
`layers` to turn it on. It saves one position per satellite every `interval`
seconds (at least 30), as `SAT-<NORAD number>`, with height and speed.

Only the groups in `satelliteGroups` are recorded (default `stations`,
`visual`, `gps-ops`, `galileo`; also `GEV_RECORDER_SAT_GROUPS`). `starlink` and
`active` are thousands of objects each, so name them only if you have the disk
for it. Element sets come from the app's own CelesTrak cache, so open the app
once with the satellites layer on to fill it. Positions are calculated, not
observed, so an old element set drifts: the recording is only as good as the
orbital elements behind it.

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

## Recording to another drive

To keep recordings off the main drive, open SETTINGS and use **Save recordings
in**. The other drives and mounted volumes the computer has are listed as chips
with their free space; pressing one fills in a folder called `GEV History` on
it, and you can type any full folder path instead. APPLY then:

1. checks the folder: it must be a full path, accept a file, and either exist
   or sit directly inside a folder that does. A drive that is not plugged in
   is refused, so no stray folder is made on the main disk;
2. copies the history so far into `history.sqlite` in that folder (leave
   "Copy the history so far" ticked), and checks the copy holds every
   position before switching. If the folder already has a `history.sqlite` it
   is used as it is and nothing is overwritten;
3. switches recording to the new place at once, with no restart, and saves the
   path in `recorder.config.json`;
4. deletes the old file only if "Delete the old copy afterwards" is ticked,
   and only after the copy checked out. It is off by default; tick it to free
   the space on the main drive.

The storage bar and the "free" figures then measure the new drive. The switch
happens between batches of writes, so no points are lost.

The storage line names the drive ("D: Backup" on Windows, the volume name on
Mac and Linux), and the chips list each other drive by its name. When the
drive that holds the recording has under 5 GB or 10% free, a line under the
bar says so in orange; under 1 GB or 3% it turns red. This looks at the drive
itself, so it still warns when a size cap keeps the recording small but other
programs fill the disk. It is not shown for PostgreSQL, whose disk is not
measured. The volume name is read once per drive (Windows asks PowerShell) and
kept for five minutes.

**If the drive is unplugged** while recording, or is missing when the server
starts, recording does not stop and does not move to the main drive. The
recorder keeps the points it cannot write in memory, the panel shows a red
line ("Cannot write to the recording folder... N points are waiting"), and it
tries to open the file again every 15 seconds. When the drive is back the
waiting points are written. Memory holds about 200,000 points; past that the
oldest waiting ones are dropped, so plug the drive back in within a few minutes
on a busy feed. The history API still answers (with nothing) while the drive is
away. This only applies to SQLite; with PostgreSQL the database server owns
the storage and the box is hidden. A `GEV_HISTORY_FILE` environment variable
fixes the location again at the next restart.

## N2YO as a backup for satellite elements

The recorder takes orbital elements from CelesTrak (through the app's own
cache). For a satellite you have **pinned** (search it, then PIN) it can fall
back on [N2YO](https://www.n2yo.com/api/) when CelesTrak did not give that
satellite, or gave a set more than five days old. This is optional and off
without a key.

To turn it on, make a free key on your n2yo.com profile and give it to the
recorder by the `GEV_N2YO_KEY` environment variable or `"n2yoKey"` in
`recorder.config.json` (the settings file is kept out of git, but it holds the
key in plain text). The key is never shown in the panel, the status or an error.

What it does and does not do: at most 20 pinned satellites; each is asked
for at most once every six hours; the recorder stops itself at 600 requests an
hour, well under N2YO's limit of 1,000. It fetches elements only and works out
positions itself, so it is not a recording source on its own, and a pinned
satellite is only recorded while the `sat` layer is on. When both sources have
a set for the same satellite, the newer one is used. The FEEDS list shows how
many pinned satellites came from N2YO. N2YO asks that nobody use several keys to
get round its limit; use one.

## Feed health

A stretch with no recorded points can mean three different things, and the
panel now tells them apart. Under the storage figures, one coloured word per
recorded layer shows how its feed is doing: green **delivering** (the last
answer carried contacts), amber **empty reply** (it answered, with none), red
**failing** (it answered with an HTTP error), grey **not asked** (nothing has
requested it for five minutes, which usually means the app is closed or the
layer is off), and grey **not seen yet** (nothing since the server started).
The FEEDS chip lists each one with its detail, such as "HTTP 429, since 15:13
UTC" or "328 contacts, 1min ago".

Changes of state are logged, so later they explain gaps. When you search for a
contact, its summary line says how many of its gaps fell while the feed was
failing or not being asked, for example "1 gaps (1 feed down)". A gap in an
empty feed is a real absence and is not labelled. AIS vessels and satellites
are read by the recorder itself on a timer, so they are never "not asked";
without an AISStream key the vessel feed simply reports empty. The log is
kept for the same time as the rest of the history.

## Settings in the panel, and thinning old data

**SETTINGS** opens a small form for how the recorder keeps data: how long to
keep it (6h, 14d, 8w, 3m, 1y; 0 keeps everything), the size cap in MB (0 for
none), how often to save a point for one contact, and which layers to record.
APPLY changes them at once, with no restart, and writes them to
`recorder.config.json` so they last. If the file cannot be written the change
still applies until the next restart and the panel says so. A setting that an
environment variable also sets (`GEV_HISTORY_RETENTION` and the others) has a
dashed box: the environment variable wins again after a restart. The database
location and the PostgreSQL address are not changeable from the panel.
Satellite sampling keeps the interval it started with until a restart.

**Thinning** keeps the history but at a coarser grain. Give an age (for
example `1d`) and a gap in seconds (for example 60): for everything older
than that, one point per contact per gap is kept and the rest are removed.
PREVIEW counts what would go, and THIN NOW (enabled only after a preview of the
same numbers) does it. Pinned contacts are never thinned. Thinning frees space
inside the database file, so the storage bar drops at once, while the file on
disk may stay the same size until it is reused. In the red zone the storage
warning points here. In these boxes `m` means months and there is no minutes
unit, so use hours (`1h`) for short ages.

## Heat map and comparing two times

**HEAT** draws where contacts were densest during the period the panel covers
(the 1h, 6h or 24h window, or from a JUMP time). It counts different contacts
in each square of a grid, not saved points, so a parked aircraft that saved few
points does not look quiet. Squares run from faint cyan (a few contacts)
through amber to red (the busiest), on a logarithmic scale so one very busy
airport does not hide the rest. The line under the chips gives the busiest
square's count. The squares are sized for the part of the globe on screen and
drawn again a moment after the camera stops. Only the layers switched on and
the REGION box, if any, count. It is laid over the globe as one image, so it
is cheap to draw, but a photorealistic 3D tiles view can cover it.

**COMPARE** shows who was present at two times. Pick time A and time B (UTC;
they start as the newest hour against the hour before) and press COMPARE.
Green dots are contacts seen at B but not at A, red dots were at A but not B,
and small grey dots were at both. The line gives the three counts. A contact
counts as present at a time if it was recorded within the ten minutes before
it. Up to 2,000 dots are drawn for each colour. ✕ clears the comparison.

## Alerts

The ALERTS chip makes the panel tell you when something happens, without you
watching it. It is off until you press it, and the choice is kept in this
browser only. When on, each new event plays a short tone and, if the browser
allows it, raises a desktop notification. The first press asks the browser for
permission; if it is refused, the panel says so and alerts then sound and show
in the panel only.

Two things raise an alert:

- A contact entering or leaving a watched area, shown with its callsign or
  name (for example "RCH871 entered Gulf box").
- A contact broadcasting an emergency: squawk 7500 (unlawful interference),
  7600 (radio failure) or 7700 (general emergency), or an ADS-B emergency
  status from adsb.lol (general, unlawful, no radio, downed, minimum fuel,
  lifeguard). Emergencies are listed in red. Minimum fuel and lifeguard are
  priority statuses: they are listed but never sound. The recorder raises one
  alert when a status starts, and another only if the contact has been quiet
  for half an hour.

An emergency alert is what the transponder broadcast in that moment. Crews pass
through 7x00 codes while dialling a new squawk, so treat it as a prompt to look,
not as a finding. OpenSky and adsb.lol carry the squawk; your own receivers'
squawk is not recorded yet. The panel checks for new alerts every five seconds
and only announces ones that happen after the page opened.

## History API (loopback only)

- `GET /api/history/status` — range plus position count, retention days and file size.
- `GET /api/history/range` — earliest and latest recorded time (epoch s).
- `GET /api/history/window?from&to&bbox=west,south,east,north&layers=air,mil,vessel,local,sat`
- `GET /api/history/track/:id?from&to` — one contact's path, with its first and last point and the gaps (over 5 minutes) with no observations.
- `GET /api/history/export?format=csv|geojson|gpx|json&from&to&bbox&layers&id` — download recorded points (one contact with `id`). The panel's CSV, GEOJSON, GPX and JSON chips download the current window.
- `GET|POST /api/history/fences`, `DELETE /api/history/fences/:id` — watched areas.
- `GET /api/history/events?since&fence&limit` — enter and exit events, newest first.
- `GET /api/history/at?to=<epoch s>&bbox&layers` — last position of each
  contact within 10 minutes before `to`.
- `GET /api/history/drives` — other drives and volumes with free space, and the folder in use.
- `POST /api/history/settings` — change retention, size cap, interval or layers (`{ retention, maxMb, interval, layers }`), and where to record (`folder`, `copy`, `deleteOld`); applied at once and saved. Same-origin JSON only. `/status` has `storage` (`path`, `ok`, `error`, `waiting`).
- `POST /api/history/thin` — `{ olderThan, keepEvery, dryRun }`; `dryRun` (the default) only counts. Returns `{ removed, total }`.
- `GET /api/history/feeds?layer&from&to` — logged feed changes for one layer (ok, empty, failing, idle), oldest first, led by the one in force at `from`. `/status` also carries the current `feeds`.
- `GET /api/history/density?from&to&cell&bbox&layers` — contacts seen per `cell`-degree square, busiest first (up to 20,000 squares).
- `GET /api/history/notices?since&limit` — area events and emergency alerts in one list, newest first.
- `GET /api/history/search?q=` — contacts whose id, callsign or name contains
  `q`, best match first (up to 20).

The MCP server adds `history_window`, `history_track` and `replay_to`, which
call these routes. Code lives in `server/recorder/`, `src/replay/` and
`src/ui/replayPanel.js`.

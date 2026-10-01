# Tracking, alerts and camera coverage

This fork adds persistent history, alerting and camera-coverage analysis on
top of the existing public feeds. Everything is off the critical path: if a
store or service fails, the globe and live layers keep working.

Open the **OPS CONSOLE** launcher (left stack) or press <kbd>`</kbd>.

## What it does

| Tab | What you get |
| --- | --- |
| Alerts | Live alerts over Server-Sent Events, toasts, desktop notifications, fly-to and recent track for each alert, acknowledge |
| Watch | Watchlists (ICAO hex, callsign prefix, MMSI, NORAD id), fences drawn on the globe (circle or polygon), rules, Slack/Discord/webhook delivery |
| Replay | Scrub or play back recorded aircraft and vessels in the current view at 1× to 900× |
| History | Search recorded assets; draw a track for 1 h to 30 d; export GeoJSON, CSV or KML |
| Cameras | Ground coverage of public cameras in view (seen by 0, 1, 2, 3+), uptime ranking and 7-day uptime per camera |

Rule kinds: enters fence, leaves fence, stays in fence for N minutes,
emergency squawk (7500/7600/7700 or custom), goes dark for N minutes,
reappears after N minutes, speed or altitude outside a band, circling inside
a radius, and satellite rising over a fence.

## How it works

- `server/providers/common/observations.js`: the OpenSky, adsb.lol and
  AISStream providers publish what they already received to a process bus.
- `server/providers/history/`: thins fixes (time, distance, turn, climb,
  squawk, ground transitions, heartbeat), stores them, applies retention.
- `server/providers/alerts/`: per-user rule engines (`src/sources/alertRules.js`,
  shared with the browser), SSE stream, webhook delivery, satellite passes.
- `server/providers/cameras/`: coverage grids (`src/sources/cameraCoverage.js`)
  and passive uptime samples from the CCTV proxy's own requests.
- `server/providers/store/`: one SQL surface on SQLite (local) or Postgres
  (hosted).
- `src/gev/console/`: the browser console, mounted after the app starts.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEV_DATA_DIR` | `.gev-data` | SQLite location (local profile) |
| `GEV_DATABASE_URL` | unset | Postgres connection string; switches the store to Postgres |
| `GEV_HISTORY_REGIONS` | unset | `name:minLat,minLon,maxLat,maxLon;…` regions kept for the long retention |
| `GEV_HISTORY_RECORD_ALL` | `1` | `0` records only regions and watchlisted assets |
| `GEV_HISTORY_PINNED_DAYS` | `30` | Retention inside regions and for watchlisted assets |
| `GEV_HISTORY_UNPINNED_HOURS` | `48` | Retention for everything else |
| `GEV_WEBHOOK_HOSTS` | unset | Extra HTTPS hosts allowed for generic webhooks (Slack and Discord are built in) |
| `GEV_HISTORY_ENABLED`, `GEV_ALERTS_ENABLED`, `GEV_CAMERAS_ENABLED` | on | `0` turns a service off |

Pinned fixes older than seven days are thinned to one per two minutes.

## Limits that are part of the design

- Camera analysis is geometric only. No frame is decoded, stored or
  analysed; uptime samples are status words from requests viewers already
  made. Nothing recognises people or reads plates, and assets are never
  linked across sources beyond the public identifier the feed published.
- History records only what the public feeds delivered. Aircraft hidden by
  their feeds (LADD/PIA) are never present to record.
- Fence math is planar on longitude/latitude; polygons cannot cross the
  antimeridian. Camera footprints are estimates from published poses.
- Tracks are as complete as the feed coverage in view while the server ran;
  gaps are shown as gaps, never interpolated across.

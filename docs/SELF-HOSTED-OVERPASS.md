# Self-hosted Overpass

The Overpass-backed layers — **Street Traffic**, **Mapped Installations**, and the
OSM webcam pack — need OpenStreetMap geometry before they can render anything.
Street Traffic in particular needs the road network before it can match TomTom
flow data onto it, so a working TomTom key alone will still leave the layer
stuck on `UNAVAILABLE · OpenStreetMap · Road data temporarily unavailable`.

By default that geometry comes from the public Overpass mirrors. They are a
shared, donation-funded community resource with a fair-use expectation measured
in a few hundred CPU-seconds per consumer per day, and this app can exceed that
by orders of magnitude in ordinary use. The operators have asked heavy consumers
to run their own instance instead (upstream issue #648). This document is how.

It is also just faster. Road geometry changes on the order of months, so a local
copy is the correct cache: queries return in milliseconds instead of seconds,
with no rate limits, no refusals, and no network dependency at all.

## Prerequisites

| | |
|---|---|
| **Docker** | Engine 20.10+ with Compose v2 (`docker compose`, not `docker-compose`) |
| **Disk** | 6–8× your chosen region's download — see the table below |
| **RAM** | 2 GB for a state or small country; 8 GB+ for a continent or the planet |
| **Time** | One import, unattended. Minutes for a state, hours for a continent, days for the planet |
| **Network** | The download is one large sustained transfer; a metered connection will notice |

The import runs once. After it finishes the container serves queries and keeps
itself current from OSM replication diffs.

## Pick a region

Coverage is the tradeoff. A regional extract answers only inside its own
boundaries — fly outside it and the layers report a failure rather than
inventing empty results (see [Region edges](#region-edges) below).

| Region | Download | Disk after import | Import time |
|---|---|---|---|
| Washington state | 0.3 GB | ~2 GB | ~15 min |
| California | 1.2 GB | ~7 GB | ~45 min |
| Great Britain | 2.0 GB | ~12 GB | ~1 hr |
| United States | 11.3 GB | ~60 GB | ~6 hr |
| North America | 18.1 GB | ~85 GB | ~8–12 hr |
| Europe | 32.6 GB | ~150 GB | ~16–24 hr |
| **Planet** | 88.3 GB | ~400 GB | multiple days |

Disk and time are approximate and scale with your storage speed; an SSD roughly
halves the import times above. Figures assume `OVERPASS_META: 'no'` as shipped —
keeping element history roughly doubles both.

Traffic only activates below 8 km altitude
([`ACTIVATION_ALTITUDE`](../src/layers/traffic/policy.js)), so you only need
coverage of the places you actually descend into. Starting with a single state
to confirm the setup works, then re-importing something larger, costs you one
extra download and nothing else.

Browse the full extract list at [download.geofabrik.de](https://download.geofabrik.de/).
To combine regions that Geofabrik does not publish together, merge the `.pbf`
files with [`osmium merge`](https://osmcode.org/osmium-tool/) before importing.

## Set it up

Start the container. Washington state is the default, so this is a complete
command for a first run:

```bash
docker compose -f docker-compose.overpass.yml up -d
```

For any other region, set `OVERPASS_PLANET_URL` to its Geofabrik `.pbf` URL:

```bash
OVERPASS_PLANET_URL=https://download.geofabrik.de/north-america-latest.osm.pbf docker compose -f docker-compose.overpass.yml up -d
```

Watch it work — this is the long part:

```bash
docker logs -f gev-overpass
```

Point the app at it in `.env`, then restart the dev server:

```
OVERPASS_EXTRA_UPSTREAMS=http://localhost:12345/api/interpreter
```

Configured endpoints are tried **before** the built-in mirrors, so yours answers
first and the public ones stay as an unused fallback. Multiple endpoints are
allowed, whitespace- or comma-separated.

## Verify

The instance is ready when this returns JSON rather than an error:

```bash
curl "http://localhost:12345/api/interpreter?data=[out:json];out count;"
```

A real road query for downtown Seattle, which should return a few hundred ways:

```bash
curl -s -X POST http://localhost:12345/api/interpreter --data-urlencode 'data=[out:json][timeout:25];way["highway"~"motorway|trunk|primary"](47.58,-122.38,47.65,-122.28);out geom;' | head -c 300
```

In the app, enable Street Traffic and descend below 8 km. The layer's status
line should settle on `LIVE · TomTom flow · N% cov`.

## Region edges

A regional extract answers HTTP 200 for queries anywhere on Earth — it simply
returns an empty element list outside its own extract. Left alone that is the
worst kind of failure: the proxy would cache "no roads here" for 7 days over
regions that have plenty.

So an empty answer from an endpoint in `OVERPASS_EXTRA_UPSTREAMS` is treated as
that endpoint **declining**, not as data. The request rotates to the next
endpoint in the chain, and if nothing can answer it the layer reports a failure
you can see. Built-in planet mirrors keep the original meaning, where an empty
result can legitimately be the truth.

Practically: outside your extract the Overpass-backed layers go unavailable
rather than blank. That is intended. Import a larger region to widen coverage.

## Changing regions later

The imported database lives in a named Docker volume. Re-importing means
discarding it:

```bash
docker compose -f docker-compose.overpass.yml down -v
OVERPASS_PLANET_URL=<new extract URL> docker compose -f docker-compose.overpass.yml up -d
```

`-v` deletes the volume — that is the point here, but it is irreversible and
means another full import. Nothing else in the app is affected.

## Troubleshooting

**Import looks stuck.** `docker logs gev-overpass` shows download progress, then
a long quiet stretch during `update_database`. Silence is normal; a state takes
minutes and a continent takes hours. Check the volume is growing:
`docker system df -v | grep overpass`.

**Queries 404 or connection refused.** The container serves nothing until the
import completes. Confirm with `docker ps` that it is `healthy` rather than
`starting` — the healthcheck allows a 30-minute grace period, which a continent
will exceed, so trust the logs over the health status for large imports.

**Every query fails with `runtime error: open64: 13 Permission denied
/db/db//osm3s_osm_base`, but the import reported success.** `/db` is the
`overpass` user's home directory and a fresh named volume inherits its `0700`
mode, so the CGI process — which runs as a different user — cannot traverse it
to reach the dispatcher socket. The compose file handles this: its entrypoint
waits for `/db/init_done` and then relaxes the traversal bit. If you are running
the image directly rather than through the compose file, do it yourself once:

```bash
docker exec gev-overpass sh -c 'chmod 755 /db'
```

**Layers still unavailable after the import.** The dev server reads `.env` at
startup, so restart it. Confirm the value took effect — the server logs
`[Overpass] 1 extra upstream(s) from OVERPASS_EXTRA_UPSTREAMS, tried first` on
the first Overpass request.

**Mapped Installations misbehaves while Street Traffic works.** That layer uses
`is_in` / admin-boundary pivots, which need Overpass area objects. Uncomment
`OVERPASS_RULES_LOAD` in the compose file and re-import; it costs noticeably
more import time, which is why it is off by default.

## Attribution

OpenStreetMap data is ODbL-licensed and requires attribution to
"OpenStreetMap contributors". The app already carries this credit in its data
attribution popover; self-hosting does not change the obligation.

# Local receivers

The Local ADS-B layer draws aircraft heard by your own receivers. It has two
inputs, and it can use both at once.

| Input        | What it is                                                                                                                         | Bands                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Browser SDR  | A USB RTL-SDR opened by the browser through WebUSB (Radio panel, Local RTL-SDR card). Decoding runs in the page.                   | 1090 MHz              |
| Decoder feed | The `aircraft.json` served by a decoder you run: dump1090-fa, readsb or tar1090 (1090 MHz), or dump978-fa + skyaware978 (978 MHz). | 1090 MHz, 978 MHz UAT |

Aircraft from both inputs are merged by ICAO address. The newest position
wins, and the click card names every band and source that heard the aircraft
in the last 60 s. Aircraft heard only on 978 MHz UAT draw with a thin ring.

Local aircraft usually lead their public twins. The public Flights layer
renders positions about one poll interval (~30 s) behind so it can interpolate
smoothly between fixes, while local receiver aircraft are shown as heard. An
aircraft in both layers therefore draws twice, the magenta local marker ahead
of the public one; both markers are drawn on purpose.

## Which to use

- **One plain RTL-SDR dongle, desktop Chrome or Edge:** use the browser SDR.
  Nothing else to install.
- **A dual-band board, a Raspberry Pi feeder, or a dongle already used by a
  decoder:** use a decoder feed. A USB dongle can be opened by only one program
  at a time, so a dongle that dump1090 or dump978 owns cannot also be opened by
  the browser.

## Configuring feeds

Feeds are set in the server environment only (`.env`), never in the browser:

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/data/aircraft.json,978=http://localhost:8978/data/aircraft.json
```

Each entry is `band=url`, where `band` is `1090` or `978`. The URL must:

- use `http` or `https`;
- point at loopback, a private (RFC1918) address, `localhost` or a `*.local`
  name. Public addresses, link-local addresses (including `169.254.169.254`),
  IPv6 and other host names are refused;
- have a path ending in `aircraft.json`, with no credentials, query or
  fragment.

An entry that breaks a rule is logged when the server starts, shown as
`invalid` and never fetched. Restart the server after changing the value.

The server reads every feed about once a second while the Local ADS-B layer is
on. A feed is `live`, `stale` (its own `now` is more than 10 s old, usually a
stopped decoder), `unreachable` or `invalid`. The Layers panel row and the
Local RTL-SDR card show these states.

## Example: dump1090-fa and dump978-fa on macOS or Linux

Write each decoder's JSON to a directory, then serve the directory on
localhost. Each command keeps running, so start each in its own terminal:

```sh
# 1090 MHz
dump1090-fa --device-index 0 --write-json /tmp/adsb1090
python3 -m http.server 8080 --bind 127.0.0.1 --directory /tmp/adsb1090

# 978 MHz UAT: dump978-fa decodes, skyaware978 writes aircraft.json
dump978-fa --sdr driver=rtlsdr,rtl=1 --raw-port 30978
skyaware978 --connect localhost:30978 --json-dir /tmp/adsb978
python3 -m http.server 8978 --bind 127.0.0.1 --directory /tmp/adsb978
```

```sh
LOCAL_RECEIVER_FEEDS=1090=http://localhost:8080/aircraft.json,978=http://localhost:8978/aircraft.json
```

A board with two identical-serial channels, such as the Nooelec FlyCatcher,
cannot be told apart by serial number. Select each channel by index:
`--device-index <n>` for dump1090-fa and `--sdr driver=rtlsdr,rtl=<n>` for
dump978-fa. `rtl_test` lists the indexes.

A tar1090 or readsb install on a Raspberry Pi already serves
`http://<pi-address>/tar1090/data/aircraft.json`. Use the Pi's private address
or its `.local` name.

## Local AIS (AIS-catcher)

**Local AIS** is a separate, opt-in, receiver-only vessel layer. It does not
need an `AISSTREAM_API_KEY` and does not change the public AISStream layer. A
vessel heard both locally and publicly may appear twice; the cyan Local AIS
marker remains distinguishable from its public counterpart.

Run [AIS-catcher](https://github.com/jvde-github/AIS-catcher) with its local
HTTP UI/API enabled, then configure the GEV **server** environment:

```sh
LOCAL_AIS_FEEDS=http://localhost:8100/api/ships.json
# Optional second local receiver:
# LOCAL_AIS_FEEDS=http://localhost:8100/api/ships.json,http://192.168.1.20:8100/ships.json
```

Restart GEV after changing the variable. Enable **Local AIS** in Layers. The
server reads `ships[]` from AIS-catcher's legacy `/ships.json` or
`/api/ships.json` endpoint, and makes it available through its same-origin
`/api/local-receivers/vessels` route. The client polls every five seconds
**only while Local AIS is enabled**. The server caches for two seconds, caps
upstream bodies at 4 MiB, and supports at most four configured feeds.

Addresses must be loopback, RFC1918, `localhost`, or `*.local`. The server
resolves and pins local hostnames before connecting, refuses redirects and URL
credentials/parameters, and never relays receiver URLs, station coordinates,
raw NMEA messages, or radio samples. Invalid configurations do not trigger
network requests. Readings older than ten minutes, positions the receiver
rejected, invalid or 0,0 coordinates, invalid MMSIs and non-vessel AIS classes
are ignored and counted. Type-27 positions are retained but marked
**approximate**, and a position the receiver has not validated yet is retained
and marked **not yet validated**. Unknown speed, course, heading and ship type
(including a ship type of 0, which AIS uses for "not available") remain
unknown rather than zero.

**Feed status.** The server reads each feed and reports one state per feed:

| State         | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `live`        | At least one vessel was heard in the last ten minutes.               |
| `stale`       | The receiver answered but has heard nothing recent (or nothing yet). |
| `unreachable` | The read failed, or the receiver's own `error` field was set.        |
| `invalid`     | The configured URL was refused and is never fetched.                 |

An empty list is `stale`, never `live`, so a receiver with a dead antenna cannot
look healthy. Liveness trusts the receiver's own `last_signal` field: a receiver
that serves a frozen or static `ships.json` would read live. The layer row is
dated by the newest message the receivers heard, not by the last poll. It reads
`not configured` (not STALE) when `LOCAL_AIS_FEEDS` is empty, and when every
feed is `stale` it reads STALE with the age of the newest message, as Local
ADS-B does (`never` when nothing was ever heard). Rows left out by design are
the classes above 8 that are not beacons: SAR aircraft (9, 10), base
stations and aids to navigation (11, 12) and class-13 rows whose MMSI is not a
beacon block. They are not drawn. The server counts
them per feed as `filtered` in the route payload, and a filtered row dates the
receiver's last activity, so a receiver that hears only those reads as alive but
quiet (STALE with an age, not `never`) and not as a fault. Drawing SAR aircraft
is a possible follow-up. Rows that are invalid (a bad MMSI, a bad or 0,0 position, a position
the receiver itself rejected) are counted as rejected, but only while the row's
`last_signal` is 600 s or less or unknown: a refused row that the receiver still
lists after ten minutes is old, not fresh bad data, and reads as STALE with its
age. A receiver with nothing fresh that is also sending recent rejected rows is
an error named `feed 1 rejected`, even when an old usable row sits beside them,
and the server logs `ROWS_REJECTED` with the count each time a feed enters that
state (from stale too), not on every poll. A refused row, however old, also
dates the receiver by its `last_signal`, so a receiver that holds only refused
rows reads STALE with an age, not `never`.
Beside a live feed, a rejecting feed is named `feed 2 rejected`, not `stale`. The
row is nominal only while at least one vessel or beacon is held within the
ten-minute window when the snapshot is read; a feed that was live a moment ago
with nothing left in the window reads STALE. Each feed reports the time of its
newest row (`newestAt`), and the browser shows a feed as stale, not live, when
that row has aged past the window by the time the snapshot is read (a slow
sibling read can make that happen), so "2 feeds live" is not said while one of
them has nothing left. A stale feed next to a misconfigured one is an
error that names the misconfigured feed. While other feeds are live, the row
names the feeds that are down, and a configuration error (`feed 1 invalid`) is
shown apart from an unreachable receiver. The server logs each feed's state changes with an error
code (for example `HTTP_STATUS`, `TIMEOUT` or `RECEIVER_ERROR`), never the
address.

### Distress and test beacons

AIS-SART, man-overboard (MOB) and EPIRB-AIS transmitters are drawn on the Local
AIS layer, but **not as vessels**. A row is a beacon when its MMSI starts with
970 (AIS-SART), 972 (MOB) or 974 (EPIRB-AIS), and by that prefix alone.
AIS-catcher gives ship class 13 to every MMSI from 970000000 to 980000000, so
the class does not mark a beacon: a class-13 row under any other prefix (971,
973, 975 to 979 and 980000000) is left out like the other filtered classes. A beacon has its own orange triangle marker and its own card, titled
by kind, that says: a distress or test beacon heard by your receiver, test
transmissions are common, and the active or test status is unknown (the
receiver's vessel list does not carry it). Only the Context card carries that
caveat, as a note: the voice model is not given it, so the voice answer does
not say that a beacon may be a test. A beacon is never listed with, or counted
as, a vessel (nearby lists, search, ship-type counts), and the view summary
leaves beacons out altogether, so a beacon in view is not in the "in view"
summary. Its card kind is "beacon", and voice is told the pick is a beacon,
not a vessel. **GEV never says an emergency is
verified.** A beacon is only something your receiver heard, and it may be a
test. Do not use GEV to decide whether to launch or call off a rescue.

A beacon follows the same rules as a vessel for age (ten minutes), refused
positions, invalid or 0,0 coordinates and the validated and approximate flags.
Hearing a beacon counts as hearing: the Layers row reads, for example, `1 feed
live · 1 beacon heard`, and a receiver that has heard only a beacon is never
"no recent messages". SAR aircraft (classes 9 and 10) stay filtered. Showing
them is a follow-up. The card and status strings are machine-translated into
the 13 locales and have not had a native review.

## What leaves your machine

The proxy and the layer keep the data local: records are transient in memory
and are not persisted. Three paths can still send data out, and each is
stopped by a different step; no single step stops all of them.

**Voice.** Local AIS is in the voice layer manifest, like Local ADS-B, so the
hosted voice model can read local vessels and beacons while voice is on. What
this protects, and what it does not:

- **What the text tools do.** They do not hand an unvalidated or approximate fix
  to the hosted model as coordinates. The analyst tools send each record's MMSI,
  name, speed, course and beacon kind and, for a validated exact fix only, the
  position. When you point at one, the pointer context and `get_entity_context`
  send its id (`local-ais:<MMSI>`) and, for a validated exact fix only, the
  cursor's ground point; for a flagged fix the id is sent and the ground and
  pointer coordinates are withheld. A flagged fix is also left out of the
  entity-context lists, nearby lists and omnibar search, and its Context card
  shows its id and kind (and, for a beacon, the beacon type and the caveat),
  with no position. A tool that needs a place for a withheld item
  answers that its position is withheld because it is not validated or is
  approximate; this applies only to a withheld Local AIS fix, never to an item
  that merely has no position. For a withheld fix, `get_entity_context` also
  drops the view centre, the viewport samples, their place names and the
  camera position (its height stays), because
  the marker may be drawn at the centre. That protection is for a pointer
  target that is withheld. `get_entity_context` in its default scope (no
  pointer) still sends the camera latitude and longitude, the view-centre
  point and the text "view centered near ...", and in pointer scope the
  nearby visible items are listed by distance from the view centre with their
  coordinates. So centring the view on a flagged fix can still reveal roughly
  where it is.
- **What it does not do.** Flagged vessels and beacons are still **drawn on the
  map**, so any path that uses the map can locate them: screenshots sent for a
  voice turn show the markers; the pointer's screen position, sent as a
  normalized fraction, can be turned into coordinates by `annotate_map`'s pixel
  resolution; and a cursor that is next to a marker, or over a card, sends the
  nearby ground point because the pick did not land on the marker; and the
  view's camera position, if you centre a flagged vessel (`get_current_view_state`
  always sends it, as it does for every layer; `get_entity_context` sends the
  camera, the view-centre point and the nearby visible items with coordinates
  as described above). These paths
  are not closed. Do not rely on the flag to keep a position away from the
  hosted model: turn the layer or voice off for that.

The voice payload carries only the manifest fields, so the `validated` and
`approx` flags do not reach the model. The layer applies default-deny to the
text path: only `validated === true && approx === false` sends a position. A fix
that is not validated, or is approximate (AIS type 27), or whose flags cannot be
read, is given to the analyst with its latitude and longitude set to null. The
model still learns that the vessel or beacon is heard. Voice can run on Codex
OAuth, so removing `OPENAI_API_KEY` does not by itself stop voice.

**HUD (voice on or off).** The HUD summary (the layer name, the record count (which
also counts beacons), the
data age and the error text, but no positions) is sent to OpenAI whenever
`OPENAI_API_KEY` is set. Turning voice off does not stop it; only unsetting the
key does.

**MCP.** The MCP `panel_request` tool can reach `/api/local-receivers/vessels`
whenever `LOCAL_AIS_FEEDS` is set, even with the layer off, so a connected MCP
client can read the vessel snapshot. Only unsetting `LOCAL_AIS_FEEDS` (or not
connecting an MCP client you do not trust) stops it.

What each step stops: turning voice off stops the voice reads and screenshots;
disabling the layer stops the voice and HUD vessel data but not the MCP route;
unsetting `OPENAI_API_KEY` stops the HUD summary but not voice on Codex OAuth;
unsetting `LOCAL_AIS_FEEDS` stops the route, and with it the layer.

The layer is registered as **local-only**: its enablement and data are not
included in share links. The AIS-catcher receiver and GEV server must be on
networks you control. Do not expose the source feed to the internet.

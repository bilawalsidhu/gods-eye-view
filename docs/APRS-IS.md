# APRS-IS live vessels

The optional APRS-IS provider is a server-side, receive-only TCP client. It
uses the existing vessel source contract and renderer; it does not create a
second visual layer. Enable it with `APRS_IS_ENABLED=1` (or `APRS_IS_HOST`) and
configure `APRS_IS_HOST`, `APRS_IS_PORT`, `APRS_IS_CALLSIGN`, and
`APRS_IS_PASSCODE`. Passcode `-1` is receive-only; `N0CALL` is used when no
callsign is supplied. Credentials remain on the server.

The endpoint is `/api/aprs-live`; no APRS.fi API or scraping is involved.
Records are bounded to 2,000 recent vessels and stale records expire after 30
minutes. Attribution: data is received from APRS-IS and APRS amateur-radio
networks.

## Viewport filter

Each snapshot request carries the camera's visible bounds (`west`, `south`,
`east`, `north`), which the server converts to an APRS-IS area filter
(`a/latN/lonW/latS/lonE`). A viewport that crosses the antimeridian is split
into two boxes. Filter updates are applied to the live connection without
reconnecting and are coalesced (change check plus a 5-second minimum interval)
so camera movement cannot flood APRS-IS.

`APRS_IS_FILTER` is the fallback used before the first viewport arrives and
whenever the viewport is absent or degenerate; it defaults to `r/0/0/180`.

## Tracking

Positions accumulate in a bounded per-reference ring buffer (64 samples per
vessel, 5,000 vessels). Selecting a vessel backfills its recent path through
`/api/aprs-live/track?reference=...`, using the same trail path as AISStream.
The reference is validated before lookup and is never interpolated into an
APRS-IS filter.

## Telemetry

APRS telemetry reports (`T#sss,a1,a2,a3,a4,a5,bbbbbbbb`) are parsed and kept per
source callsign: the latest sample plus a bounded recent history (32 samples).
Analog channels are reported raw because their units live in the station's
separate `PARM`/`UNIT`/`EQNS` messages, and the raw sequence, five analog
values and eight digital bits are what the API exposes. Telemetry is attached
to the matching vessel record and returned by the track endpoint; no telemetry
units are invented.

The latest reading is rendered through the existing vessel card detail-line
contract rather than a dedicated renderer: a `TLM #n · A: … · D: …` detail line
on the selected card, a compact `TLM #n` summary on ambient cards that have no
other metrics to show, and a monospace telemetry line in the vessel HUD. A
refresh without a telemetry report keeps the last known reading, and APRS rows
are labelled `APRS`/`CALL` while AIS rows keep `AIS`/`MMSI`.

## Limitations

- AIS multipart (type 5 static data) and long-range type 27 reports are not
  decoded.
- AIS and APRS beacons share one provider contract; APRS beacons have no MMSI,
  so their identifier is the callsign.

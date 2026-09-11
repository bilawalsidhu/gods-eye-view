# Traffic lights

Enable **Traffic Lights** in the data-layer panel, then zoom below 8 km.
The app queries OpenStreetMap for mapped signals and signal-controlled pedestrian
crossings in a local 0.05-degree box around the view center. Click a marker for
its direction, state, timing, source and coordinates. Gray means unknown, not off.
Locations are incomplete community mapping; a node can represent an intersection,
an approach or a crossing, rather than an individual lamp. The display is capped
at 4,000 records and labels this limit. It does not load every signal worldwide.

Mapped locations work worldwide where OpenStreetMap has data. Live reports are
connected automatically in **Hamburg, Germany**, using its public SensorThings
service. No account or API key is needed. Try the area around **53.5638, 9.9196**
below 8 km altitude. Outside this source's coverage the panel explicitly says
**No connected live provider here; mapped locations only**.

Hamburg publishes last-reported signal colors, not transition countdowns or
accuracy bounds. Recent observations are labeled **LAST REPORTED** with their
approximate age. After at most five seconds (including request/clock allowances),
the current state becomes unknown; the last report remains inspectable with its
timestamp. The app does not extend the provider's zero-length `validTime` into
an invented validity deadline. An old report fetched again stays old.

Requests are limited to 64 signal streams per local area, with a visible limit
notice when more exist. Zoom/move to another area to change the selection. The
client refreshes about two seconds after each response and skips external requests
outside Hamburg. Invalid or future-dated controller timestamps are rejected.
Provider documentation: [Traffic Lights Data Hamburg usage guide](https://daten-hamburg.de/tlf_public/TLD_UsageGuide_V1.2.pdf).

**Worldwide live coverage is not supplied.** Additional regions need their own
public source or an authorized provider. Vehicle animation and TomTom congestion
never determine a light's state.

## Connect an authorized live feed

To override the automatic public source with your own provider, set
`TRAFFIC_SIGNALS_FEED_URL` and optionally `TRAFFIC_SIGNALS_FEED_TOKEN` in
the server environment or root `.env`, then restart Vite. The token is sent as a
Bearer header by the server and is never exposed to the browser. HTTPS is required
except for a loopback development adapter. The server adds WGS84 `south`, `west`,
`north`, `east` query parameters. Redirects are rejected. Responses are bounded
to 4 MiB / 4,000 signals and a 2.5-second upstream timeout. No timing responses
are cached. The browser polls once a second after each completed response.

The adapter must return this JSON contract (numbers below are illustrative;
real timestamps must come from the current request and live observations):

```json
{
  "serverTimeEpochMs": 1789000000000,
  "clockUncertaintyMs": 20,
  "signals": [{
    "id": "city:intersection-123:north:left",
    "lat": 49.2827,
    "lon": -123.1207,
    "name": "Example intersection",
    "movement": "North approach, left turn",
    "source": "Your authorized signal operator",
    "state": "red",
    "observedAtEpochMs": 1788999999500,
    "validUntilEpochMs": 1789000003500,
    "changeAtEpochMs": 1789000012000,
    "resolutionMs": 1000,
    "uncertaintyMs": 500
  }]
}
```

- All epoch times are Unix **milliseconds**, in the same clock domain.
  `serverTimeEpochMs` must be sampled while handling this request, including when
  observations are cached; never replay a cached server timestamp. Report clock
  uncertainty honestly. The browser anchors this to its monotonic clock and adds
  half the complete request round trip to the uncertainty budget.
- `observedAtEpochMs` is the actual observation time, not the adapter fetch time.
  `validUntilEpochMs` is the source's validity deadline for the reported state.
  Neither may be invented or extended by the adapter.
- States: `red`, `yellow`, `green`, `flashing-yellow`, `off`, `unknown`.
  Combined `red-yellow` and `flashing-green` states are also supported.
  Every record must identify its approach/movement and source. Different movements
  need different IDs. No proximity-based matching to OSM is performed.
  Use `osm:<node-id>` only when the feed is explicitly matched to that exact node
  and movement; otherwise provider records appear separately.
- Providers that supply observations without a timing guarantee can set
  `observationOnly: true` and omit validity, transition, resolution and uncertainty
  fields. These are labeled as reports, never given a countdown or claimed as a
  guaranteed current state. The snapshot still needs a timestamp reference and
  a clock allowance for conservative freshness checks.
- `changeAtEpochMs` is optional. Without it a fresh state can display with
  **Countdown unavailable**. `resolutionMs` is the source's actual timing
  resolution, and `uncertaintyMs` its timing error bound. Unknown source timing
  must remain unknown. Invalid records and duplicate IDs are discarded.
- Coordinates must already be WGS84. Adapters for BD-09 or GCJ-02 data must
  transform coordinates appropriately before returning them.

The app includes source quantization and clock/network uncertainty, expires
observations after at most five seconds, and clears state before its validity
or predicted transition boundary falls within that uncertainty window. It never
cycles through assumed phases or holds green after expiry. A failed poll clears
timing immediately. It shows three decimal places only for millisecond-resolution
sources, always labeled **estimate** with uncertainty. Display updates follow
browser frames; decimal precision is not a millisecond accuracy guarantee.

This is an adapter contract, not a built-in Baidu/Amap integration. Baidu's
[dynamic signal API](https://lbsyun.baidu.com/docs/webapi?title=lamp_service/countlight/route)
requires a server key and road link IDs, returns second-based countdowns, and
documents unknown countdowns (`10000`) and a separate confidence interval
(`period`). An adapter must honor those semantics; it must not pass unknowns
through as real countdowns. No universal signal-state service or millisecond
accuracy is supplied by this repository.

## Verification

`node --test src/data/trafficSignalsModel.test.mjs src/trafficSignalsProxy.test.mjs src/trafficSignalsProviders.test.mjs`
checks parsing, timing boundaries, uncertainty, date-line bounds, missing feeds,
request validation and upstream failures. Provider coverage and physical timing
accuracy require separate verification against the actual signal controllers.

`node scripts/qa-traffic-signals.mjs` exercises the layer in a headless browser
with real Cesium markers and deterministic fixture feeds, including selection,
countdown updates, feed failure, disable/re-enable, altitude gating and cleanup.
The voice layer controls also accept `traffic-signals`; this intentionally changes
their two enum definitions and the pinned voice-schema checksum.

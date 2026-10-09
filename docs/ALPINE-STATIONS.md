# Alpine Stations layer

Design notes and traps for `src/layers/alpineStations/`, its adapters under
`src/layers/alpineStations/networks/`, and the proxy in
`server/providers/alpine-stations.js`.

Everything below was learned by hitting it against live data. Several of these
look like bugs in your new code when they are not, so read this before changing
the layer or adding a network.

## What the layer is

About 650 automatic weather stations across the Swiss and Austrian Alps, drawn
as simple markers coloured by one selected measurement, with the readings, the
legend and the nearest stations in view in a card in the WEATHER rail.

Three networks, one adapter each. All three are keyless and CC BY 4.0, which is
the condition of inclusion: the layer works on a fresh clone with no
credentials, like USGS earthquakes rather than like TomTom.

| Network | Stations | Cadence | Publishes |
|---|---|---|---|
| SLF IMIS (CH) | ~200 | 30 min | snow, wind, temperature |
| SwissMetNet (CH) | 159 | 10 min | wind, temperature, precipitation, pressure |
| GeoSphere TAWES (AT) | ~285 | 10 min | snow, wind, temperature, precipitation |

## The shape of it

```
src/layers/alpineStations/
├── networks.js          the registry: who, where, licence, WHAT EACH PUBLISHES
├── parameters.js        the five views, their bands, units and staleness rules
├── records.js           the canonical record, merge, summary, nearest, card copy
├── networks/slf.js      \
├── networks/smn.js       }  pure adapters: payload in, canonical records out
├── networks/tawes.js    /
├── model.js             marker colour/size and ambient labels (no Cesium)
├── source.js            the browser read of /api/alpine-stations
└── index.js             the Cesium layer and the rail card descriptor

server/providers/alpine-stations.js      caching, coalescing, throttle, envelope
server/providers/alpine-stations/
├── upstreams.js         every fixed URL with its own read cap
└── fetchers.js          one fetch step per network
```

Nothing downstream of an adapter is network-aware. The adapters are pure, so
both the proxy and the browser import the same normalisation and it is tested
under `node --test` rather than only in a browser.

## The registration points

A layer is not "added" until all of these are done. Missing one fails quietly,
in a different way each time:

1. `src/sources/reference.js` — construct the source.
2. `src/app/constructCatalog.js` — `SOURCE_METHODS`, the instance, and a
   metadata entry. `constructCatalog.test.mjs` pins the layer count.
3. `src/ui/layerPanel.js` — the Weather group **and** the subscription list in
   `_refreshWeatherPanel`. Two separate lists; a layer in one and not the other
   either never refreshes its card or refreshes a card it has no row for.
4. `src/ui/weatherPanel.js` — `ORDER`, and a `LIST_BLOCK_IDS` entry if the card
   has a list.
5. `src/data/dataCredits.js` — attribution, or the credit never appears, which
   is a licence breach rather than a cosmetic gap.
6. `DATA_SOURCES.md` — licence and attribution text.
7. `src/voice/layerManifest.js` — or `layerManifest.test.mjs` fails.
8. `scripts/package-boundaries.json` — every new module, in every group that
   transitively reaches it. `npm run check:boundaries` names them one at a time.

## The share-link token

This layer has **no token**, by request: the namespace is the maintainers' to
allocate (see #658). It is registered with `disposition: 'pending-share-token'`,
a valid serialization disposition meaning "registered and drawable, never
serialized". The only consequence is that its enabled state and its selected
parameter do not travel in a share link.

Completing it is one change: move the entry from
`PENDING_SHARE_TOKEN_LAYER_METADATA` into `LAYER_STATE_REGISTRY` with a token
and an `OPTION_GROUPS` entry for `parameter`. Note the trap recorded on the
earlier branch: **`optionOwner` must be a registered LAYER id**.
`encodeLayerStateParams` resolves the owner through `REGISTRY_BY_ID` to find its
token, and an owner named anything else passes every registry test and then
throws on the first share link generated.

## Traps

### GeoSphere aligns `data` to a UNION of timestamps

This is the big one. `timestamps` is the union of observation times across every
station in the request, ascending, and each station's `data` arrays align to it
positionally while carrying a value at only **one** index: its own latest.

Reading `data[0]` therefore returns null for almost every station. Measured
live, 275 of 285 stations sat at the last index and `data[0]` was non-null for
exactly one of them. `tawesReadingIndex` discovers the index per station; a null
at the chosen index then means a genuinely absent sensor rather than a stale
slot, which is how per-station staleness comes out for free.

It also means the observation call cannot be flattened before it is read: an
index is only meaningful against the `timestamps` array of the response it
arrived in. `tawesReadings` reads each chunked response before anything merges.

### Pressure is QFF, and two of the three networks cannot supply it

Station-level pressure (QFE) is a map of ALTITUDE, not of weather. Measured
across SwissMetNet, `prestas0` spanned 663-991 hPa on a day whose real synoptic
spread was under 3 hPa.

- **SwissMetNet**: use `pp0qffs0` only. `pp0qnhs0` (QNH) has better coverage but
  reduces through the ICAO standard atmosphere, so it carries an altitude bias;
  it is not an acceptable substitute. The price is coverage — roughly a third of
  the network publishes QFF and the rest correctly render as "no reading".
- **GeoSphere**: neither column is usable. `PRED` looks like a sea-level
  reduction and is one for low stations, but Wien/Hohe Warte at 198 m reads
  P 991.7 against PRED 1016.4 while Sonnblick at 3109 m reads P 696.7 against
  PRED 707.7 — an 11 hPa correction over three kilometres. Nothing in the
  payload says which regime applies. `pressure` is absent from that network's
  registry entry and a test pins the exclusion.

### SwissMetNet wind is km/h in one column family and m/s in another

`fu3010z0`/`fu3010z1` are **km/h**; `fkl010z0` is m/s. Both exist for the same
quantity. VQHA80 carries the `fu3` family, canonical records store m/s, so the
adapter converts. Passing them through overstates every Swiss wind by 3.6×.

### The SwissMetNet metadata CSV is ISO-8859-1, not UTF-8

`Response.text()` assumes UTF-8 and mangles `Oberägeri`, `Bière`,
`Lötschental` and `Château-d'Oex`. The proxy reads bytes
(`readResponseBytesCapped`) and decodes with `new TextDecoder('iso-8859-1')`.

### SwissMetNet timestamps are `YYYYMMDDHHMM` in UTC

Both halves are traps: `new Date(text)` cannot read the layout, and any
local-time reading is one or two hours out in Switzerland, which is enough to
make a current reading look stale. Use `parseSmnTimestamp`.

Separately, GeoSphere's `valid_from`/`valid_to` carry **no zone** and parse as
local time. Nothing reads them; do not start.

### `stats.stale` is a reserved feed-level boolean

`layerFeedState()` renders the whole row as **STALE** on any truthy
`stats.stale`. Reporting a count of late stations there made a healthy
157-station feed read STALE. Two separate things:

- `stale` — the proxy served a cached payload after an upstream failure.
- `staleStations` — how many individual stations are behind.

### Absent is not zero

0 cm, 0 mm and 0 °C are all real, common readings, and a station without a
sensor leaves its column empty. The automatic snow sensor also reports small
negatives over bare ground (-1.0 cm measured), which is a working sensor saying
"no snow" — so the snow band table has an **open floor** rather than `min: 0`,
or bare ground would drop out of the scale and render identically to a station
with no sensor at all.

Three marker states exist for the same reason, and collapsing them would assert
readings that were never made: a current value, `unmeasured` (the station is
reporting, but not this parameter), and `offline` (silent, or too old to
present).

### A silent station is not a stale station

It has no reading to be out of date. They read differently on the card and
`isStale` returns false for a station with no `measuredAt` at all.

### Staleness is per network

SLF publishes every 30 minutes and the other two every 10, so one global window
is wrong for at least one of them. `staleAfterMs` takes six cycles of the
network's own cadence with a 90-minute floor. A cutoff is not optional: one
SwissMetNet station was last seen seven days back while otherwise reporting
normally, and without one it rendered as a healthy reading.

### Fixtures must be cut from live responses

An invented SwissMetNet fixture on the earlier branch hid that the live STAC
item publishes no `station_name` and no elevation ordinate. Every test stayed
green while every station rendered as its bare code with no altitude.
`src/testSupport/alpineStationFixtures.mjs` is cut from real payloads, and the
one thing arranged rather than captured (which timestamp slot each GeoSphere
station reports in) is called out in its header.

## Rendering

Geometry is **static**, following the earthquakes layer. Points are written only
when a poll brings new data or the selected parameter changes; there is no
`CallbackProperty` and no continuous-render hold, so an open map with this layer
on costs nothing per frame. `LayerPresentation` already requests a render on
layer activity, so the layer does not call the render governor itself.

A parameter change **recolours in place**. 650 entities are cheap to tint and
expensive to reconstruct, and reconstructing them would discard the scene's
picking and labelling work for no reason.

The camera is read only on `moveEnd`, and only to recompute the card's six-row
"nearest in view" list — never geometry. The layer compares the new membership
against the old and publishes nothing when it has not changed, so panning within
one valley does not rewrite the rail on every gesture.

### Wind arrows

In the wind view a station that has something to say about direction draws an
arrowhead instead of a dot. Four things must all hold, and each omission is
deliberate: this is the wind view, the station has a current reading, it has a
working vane, and the air is actually moving above `WIND_ARROW_CALM_FLOOR_MS`.
A vane in still air is reporting noise, and pointing an arrow with it would
assert a direction the station never really measured.

**The arrow points downwind.** All three networks publish the direction the
wind blows FROM, per the WMO convention, so the arrow is the reverse of the
published figure. The card and the ambient label keep the meteorological
reading: "22 km/h W" is wind FROM the west, drawn as an arrow pointing east.

**Orientation is screen-space, and that is not optional.** A billboard is a
camera-facing quad, so a world bearing has to be resolved against the camera.
This follows the repo's established approach — `alignedAxis: Cartesian3.ZERO`
with a `rotation` from `screenProjectedRotation`, as the flight and vessel
layers do. Do NOT reach for `alignedAxis`: `src/data/iconOrientation.js`
records why that approach was abandoned.

Two consequences worth knowing:

- Arrows are re-aimed on camera **settle**, never per frame. Re-aiming writes
  one number per visible arrow; it creates, destroys and re-tessellates
  nothing, so the layer still builds no geometry in response to the camera and
  still takes no continuous-render hold. `stabilizeScreenRotation` holds
  through sub-degree projection noise so a settled camera does not jitter
  hundreds of arrows against their own rounding.
- **Aim with the cartesian, not `entity.position`.** Cesium wraps an entity
  position in a `PositionProperty`, and handing one to the projection yields
  no rotation at all — the arrows then sit at a fixed screen angle that looks
  plausible and means nothing. This shipped briefly and was caught by the
  browser gate, not by unit tests, because the test fixture was handing back a
  plain cartesian where Cesium hands back a property. The fixture now models
  the wrapper and a test pins it.

A station carries BOTH a `point` and a `billboard` and shows one, so switching
parameter swaps the symbol without replacing the entity. The dot follows
whether an arrow was actually attached rather than whether one was wanted:
without a canvas there is no arrow image, and a station must never end up with
neither symbol.

The arrow texture is a memoised data URL, not a canvas. `Billboard.image`
assigns a fresh texture-atlas id to every non-string source, so handing the
same canvas to hundreds of billboards still makes Cesium upload and repack
hundreds of identical textures; `cockpitContactDotImage` records the same
finding. One white arrowhead is tinted per station through `billboard.color`.

### Ambient labels

Ambient overlay entries are `variant: 'label'` carrying just the reading
(`"22 km/h W"`, `"-3.5 °C"`). One `variant: 'card'` per station was the first
cut of this on the earlier branch and it buried the map: at Alpine zoom the
detail boxes covered the country. Labels are dropped past
`ALPINE_OVERLAY_MAX_DISTANCE_M`; the markers keep rendering, so the network
stays visible as a network while the numbers stop competing for space.

Snow depth is drawn as **colour, not as a vertical stem**. The earlier branch
drew stems scaled to camera altitude, which required rebuilding geometry on
every camera settle. That is what the current design exists to avoid.

## Adding a network

1. Check the terms. Keyless and redistributable, or it does not belong here.
2. Add an entry to `ALPINE_NETWORKS`, listing only the parameters it can supply
   **honestly** — see the pressure trap above for what dishonest looks like.
3. Write a pure adapter in `networks/` that returns canonical records. Cut its
   fixture from a live response.
4. Add its fixed URLs and read caps to `server/providers/alpine-stations/upstreams.js`
   and a fetch step to `fetchers.js`, then name it in `FETCHERS`.
5. Add it to the credit entry in `src/data/dataCredits.js` and to
   `DATA_SOURCES.md`.

Nothing else changes. The views, the bands, the card, the markers and the
summary are all network-neutral.

## Verifying

```bash
npm test                      # unit suite, including the live-cut fixtures
npm run build
npm run check:boundaries
node scripts/qa-alpine-stations.mjs           # live browser gate
```

The QA gate drives the real layer in the real app: it enables the layer, waits
for the proxy, and asserts the markers, the rail card, the legend, the nearest
list and a parameter change that recolours without rebuilding.

Headless Chrome needs `--use-gl=angle --use-angle=swiftshader`; plain
`--use-gl=swiftshader` fails to create a WebGL context.

### A new `/api` route needs a container restart

Vite reads its config once at boot, and inside the container the config watcher
does not fire across the bind mount. A newly added route returns `index.html`
through the SPA fallback, so the browser reports
`Unexpected token '<', "<!DOCTYPE "... is not valid JSON` and the row shows
UNAVAILABLE while every pre-existing proxy keeps working.

```bash
docker restart gods-eye-view-gev-1
curl -s -o /dev/null -w '%{content_type}\n' http://localhost:4173/api/alpine-stations
# text/html => middleware not registered; application/json => good
```

## Not in this change

- **Map-click selection.** Selecting a station is the rail card's list. The
  click path the cyclones layer uses is about a hundred lines of competing
  overlay and pointer-ownership handling, and it is a separate change.
- **A share-link token.** See above; the namespace is the maintainers'.
- **Avalanche bulletins.** A danger rating is a different product with
  different authority, and this layer must never read as one. Note for anyone
  who tries: `aws.slf.ch/api/bulletin/caaml` and `aws.slf.ch/api/warningregion/`
  both return HTML rather than data when fetched directly, despite being cited
  on SLF's own data-service page. Find the real endpoints first.

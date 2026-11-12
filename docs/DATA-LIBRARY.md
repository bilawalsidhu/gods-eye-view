# Data Library

DATA LAYERS is the curated set of core layers. The Data Library holds
everything else: regional sources, niche themes and community contributions.
A viewer opens it from **DATA LAYERS ▸ Browse data library**, adds what they
want, and the entry appears in the panel under **Library**. Nothing in the
library is on until someone adds it.

Runtime behaviour is described in [CURRENT-STATE.md](CURRENT-STATE.md#data-library--october-21-2026).
This page is the authoring guide.

## The one rule: live sources only

A library entry points at data its provider hosts. That can be a query API, a
static file at a stable URL the provider controls, or a tile endpoint. The
data is never copied into this repository. If the upstream goes away, the
entry goes stale; this project never becomes the host of record. That is what
lets every self-hosted instance serve the whole library with no data of its
own.

It also keeps the existing rule in [CONTRIBUTING.md](../CONTRIBUTING.md): do
not add data you have no right to redistribute. A live source still needs a
licence that allows this use, and the manifest must say what it is.

## Kinds

| Kind | What it is | Renders through |
| --- | --- | --- |
| `dataset` | Vector features: `geojson`, `geojsonl`, `csv` (lat/lon columns), `json` (a record list with lat/lon fields), `arcgis` (a FeatureServer or MapServer layer, paged) or `geoparquet` (one file, or a partitioned set on S3) | The GeoJSON layer Datacenters and Dams use; view-bounded and GeoParquet sets draw as ground-clamped dots and polygons |
| `tiles` | Raster tiles: `xyz` with a `{z}/{x}/{y}` template (`{reverseY}` for TMS rows), or `bbox` with a `{bbox-epsg-3857}` template (WMS GetMap, ArcGIS `export`/`exportImage`) | The active map's imagery host (globe or Google 3D tiles) |
| `pack` | A source pack an existing host layer already loads (today: CCTV) | The host layer, switched on by its own environment variable |

A `dataset` or `tiles` entry needs no JavaScript. A `pack` documents a host
layer's opt-in source so viewers can see it and operators know the switch; the
host layer owns its code. Provider entries (code implementing a family
contract, such as a Street Level provider) are not supported yet and are
refused by the validator.

## Add an entry

1. Create `src/library/entries/<id>.json`. The id is 3–48 lowercase letters,
   digits or dashes and is permanent.
2. Add one import line for it in `src/library/catalog.js` (keep the list in
   file-name order).
3. For a `dataset` or `tiles` entry, run `npm run library:next -- <id>` and
   append `["<id>", "<token>"]` to `src/library/ledger.json`. Tokens are
   permanent: never change or reuse a row, even when an entry is removed.
   Packs take no token.
4. Run `npm run library:docs` to regenerate the DATA_SOURCES.md table.
5. Run `npm run library:check -- --base-ref origin/main`,
   `npm run library:probe`, `npm test` and `npm run qa:data-library`.
6. Open a pull request with a `changelog.d/` fragment.

Start new entries at `"status": "community"`. Maintainers move an entry to
`verified` after reviewing its licence and seeing it stay healthy; `stale` and
`archived` mark entries whose upstream has stopped answering. Archived entries
are hidden from Browse unless a viewer already added them.

## Manifest reference

```json
{
  "id": "eia-power-plants",
  "kind": "dataset",
  "family": "infrastructure",
  "title": "US power plants, 100 MW and up (EIA)",
  "provider": "EIA",
  "description": "Operating US power plants with at least 100 MW of capacity.",
  "icon": "ϟ",
  "maintainer": "github:your-handle",
  "coverage": { "countries": ["US"], "bbox": [-180, 13, -64, 72] },
  "source": {
    "format": "arcgis",
    "url": "https://services2.arcgis.com/…/Power_Plants_in_the_US/FeatureServer/0",
    "query": { "where": "Total_MW >= 100", "outFields": "Plant_Name,PrimSource,Total_MW" },
    "fetch": "browser-direct",
    "cacheSeconds": 86400,
    "maxFeatures": 4000,
    "maxPages": 3
  },
  "display": {
    "color": "#ffc23d",
    "label": "Plant_Name",
    "fields": ["PrimSource", "Total_MW"],
    "rank": { "field": "Total_MW", "order": "desc" }
  },
  "licence": { "name": "EIA data: public domain", "url": "https://www.eia.gov/about/copyrights_reuse.php" },
  "attribution": { "text": "U.S. Energy Information Administration", "url": "https://atlas.eia.gov/" },
  "status": "community",
  "reviewed": "2026-10-21"
}
```

Unknown fields are errors, so a typo cannot silently drop a cap or a licence.

| Field | Required | Notes |
| --- | --- | --- |
| `id`, `kind`, `family`, `title` (≤ 60), `provider` (≤ 32), `description` (≤ 240), `maintainer`, `status` | yes | `family` is one of movement, cameras, infrastructure, events, weather, environment, imagery. `provider` is the short name the panel row shows. |
| `coverage` | yes | `global: true`, ISO 3166-1 alpha-2 `countries`, and/or a `bbox` `[west, south, east, north]`. |
| `source.url` | yes | https, a real hostname, no credentials or fragment. |
| `source.format` | yes | Datasets: `geojson`, `geojsonl`, `csv`, `json`, `arcgis`, `geoparquet`. Tiles: `xyz` (`{z}`, `{x}` and `{y}` or `{reverseY}`) or `bbox` (one `{bbox-epsg-3857}`, filled with the tile's Web Mercator bounds in metres, as MapLibre does). Packs: `host`. |
| `source.records` | no | JSON only: the property path to the record list, such as `stations` for `{ "stations": [ … ] }`. Omit when the response is the list itself. |
| `source.fetch` | datasets, tiles | `browser-direct` when the upstream sends CORS headers and needs no key; otherwise `proxied`. |
| `source.query` | no | Query parameters added to the URL. For `arcgis`, `where` and `outFields`; geometry is always WGS84 GeoJSON. |
| `source.columns` | no | CSV or JSON: `{ "lat": "…", "lon": "…" }` when the fields are not lat/latitude/y and lon/lng/longitude/x. |
| `source.cacheSeconds` | no | 60–86,400, default 3,600. How long the proxy keeps a response. |
| `source.maxBytes` | no | Body cap, default 16 MiB, at most 32 MiB. |
| `source.maxFeatures` | no | Feature cap, default 10,000, at most 20,000. A capped dataset reads PARTIAL. |
| `source.maxPages` | no | ArcGIS pages to follow, default 5, at most 10. |
| `source.view` | no | `{ "maxAltitudeM": 300–50000, "sample": [w, s, e, n] }`. Makes a huge ArcGIS layer view-bounded: below that camera height it loads what is in view, one page at a time; above it the row asks the viewer to zoom in. Needs `arcgis` or `geoparquet`, and `browser-direct`. `sample` is where Zoom to layer lands and what `library:probe` queries. |
| `source.partitions` | no | GeoParquet only: `{ "listUrl": "<S3 ListObjectsV2 URL with prefix>", "keyBase": "<URL keys are relative to>" }`, both on the source host. Needs `source.view`. The library indexes each file by its footer bbox and reads only the files in view. |
| `source.minZoom`, `source.maxZoom` | no | Tiles only, 0–22. |
| `source.encoding` | no | Tiles (`xyz`): `terrarium` when the pixels are elevation as terrain-RGB (height = R × 256 + G + B / 256 − 32768 m). The browser draws them as shaded relief: one orange ramp in six elevation classes (legend in metres), lit from the north-west; sea (exactly 0 m) is transparent. |
| `source.tileSize` | no | Tiles: 256 (default) or 512 px. |
| `source.bounded` | no | Tiles with `coverage.bbox`: `true` requests tiles inside the bbox only. Required for aerial imagery, whose servers paint a fill (white, a flat ocean, a coarse world mosaic) everywhere they have no photos. A 4xx tile answer is treated as "no imagery here", never retried or counted as an error. |
| `source.key` | no | `{ "id": "<key registry id>", "in": "query" \| "header", "name": "…" }`. The id must exist in `src/keySetupCore.mjs`. A keyed entry must be `proxied`, so the key never reaches the browser. |
| `display.color`, `display.label`, `display.fields` (≤ 4, two shown) | no | Datasets only, except `opacity`. |
| `display.rank` | no | `{ "field": "…", "order": "desc" \| "asc" }`. Keeps the most important features when capped and lets the map prefer them at global zoom. Numbers or ISO dates. Without it, a zoomed-out view shows whichever features come first. |
| `display.colorBy` | no | View-bounded datasets: `{ "field": "…", "colors": { "<value>": "#rrggbb" }, "labels": { "<value>": "…" } }`, up to 12 values. Colours each feature by value; the row legend lists each label with the count in view. |
| `display.legend` | no | `[{ "label": "…", "color": "#rrggbb" }]`, up to 12: a static legend, such as a tile layer's colour scale. Take the colours from the provider's own legend or colour map. |
| `display.outline` | no | Tiles: `countries` outlines every part of each covered country, `coverage` only the parts inside `coverage.bbox`, `bbox` the bbox rectangle itself (a state, county or city inside a country). Use it for aerial imagery so its edge shows. |
| `display.aerial` | no | Tiles: `true` for aerial or satellite photography. It drapes above every other imagery layer, including core overlays, and stays there when another layer is switched on. Pair it with `source.bounded`. |
| `display.noDataColor` | no | Tiles: `#rrggbb` of the provider's no-imagery fill, drawn transparent (within a small tolerance for JPEG noise along its edge). Measure it from a tile outside the coverage; do not guess. Globe maps only: Google 3D tiles ignore it. |
| `display.opacity` | no | Tiles: (0, 1]. |
| `imagery` | no | Tiles: what a photo layer is. `type` (`ortho`, `satellite-mosaic`, `oblique`, `historic`), `resolution` as the provider publishes it ("10 cm (plains) / 25 cm (Alps)"), `resolutionM` (the finest, in metres), `trueOrtho`, and optional `vintage` ("2021–present"), `updateCycle`, `orthoQuality` and `registry` (an https link to where the metadata came from). Browse shows it as a spec list on the card. |
| `pack` | packs | `{ "host": "cctv", "env": "CCTV_EXAMPLE_ENABLED" }`. Packs are always `licence.operatorOptIn: true`. |
| `licence` | yes | `name`, an https `url`, and `operatorOptIn: true` when the terms need the operator's own agreement or consent. |
| `attribution` | yes | `text` and an optional https `url`; shown in the Data attribution popover while the entry is in use. |
| `regionsServed` | no | ISO codes, when the upstream only answers from some countries. |
| `reviewed` | no | `YYYY-MM-DD` of the last licence and endpoint review. |

## Aerial imagery from the Open Imagery Register

The aerial photo entries came from the [Open Imagery Register](https://imagery-registry.netlify.app/)
on 2026-10-23: every register source with a map preview, less the ones that
fail the library's rules. Each entry keeps the register's resolution, product
type, true-ortho flag, years flown and refresh cycle in `imagery`. Before an
entry was written, a tile inside its coverage was fetched in a browser from
the app's origin: it had to be a real photo (not a blank fill), and the
provider had to send CORS headers (or the entry would be `proxied`). The
fill a provider paints at its coverage corners became `display.noDataColor`.

Left out, with the reason:

| Register source | Why |
| --- | --- |
| NASA GIBS true colour | Already in core (Recent imagery). |
| Sentinel-2 cloudless (EOX) | CC BY-NC-SA: non-commercial. |
| SWISSIMAGE Bern and Marion County PMTiles | Extracts hosted by the register, not the provider. |
| Cabarrus County NC, Hawaii, Nashville, Sioux Falls | Credit a commercial imagery vendor (EagleView, Maxar WorldView, Pictometry, Nearmap). |
| DVRPC, Missouri, Washington | The preview serves a blank white tile across the coverage centre. |
| Sarasota County FL | The service now requires a token. |

Entries whose register licence reads "see publisher terms" or "verify portal
terms" are `licence.operatorOptIn: true`: an operator reads the publisher's
terms and lists the id in `GEV_LIBRARY_ENABLE`. Re-check an entry's terms and
drop the opt-in when its publisher states an open licence.

## Choosing a fetch mode

Use `browser-direct` when the upstream answers a browser on another origin
(`Access-Control-Allow-Origin`) and needs no key. Tile servers must send CORS
headers for WebGL to use them; without them, use `proxied`.

Use `proxied` otherwise. The proxy is generic: there is no per-entry server
code. It reaches only the manifest's host, refuses redirects, caps bodies,
caches per `cacheSeconds` and never returns upstream error text. The browser
names an entry id, never a URL, so the proxy cannot be pointed anywhere else.

## Operator switches

| Variable | Effect |
| --- | --- |
| `GEV_LIBRARY_ENABLE` | Comma-separated ids of `operatorOptIn` datasets and tiles to serve. |
| `GEV_LIBRARY_DISABLE` | Comma-separated ids to remove from this instance. |
| A pack's own variable | For example `CCTV_NYC_ENABLED=1`; Browse then shows the pack as switched on. |

## When an entry belongs in core instead

A library entry can be proposed for DATA LAYERS when it has global or
near-global coverage, is keyless or uses a key the registry already has, has
stayed `verified` with no stale period for about six months, and a core
maintainer will own it. Promotion and demotion are maintainer decisions.

# CCTV source packs

Hand-authored camera catalogs for the CCTV layer. Point the dev server at one
with `CCTV_SOURCES_FILE`:

```bash
CCTV_SOURCES_FILE=config/cctv_sources.kualalumpur.json CCTV_FORCE_AUSTIN=1 npm run dev
```

**`CCTV_FORCE_AUSTIN=1` is not optional if you want to keep the live cameras.**
Setting `CCTV_SOURCES_FILE` (or `CCTV_SOURCES_JSON`) disables the live open-data
packs — see `refreshCctvSources` in `vite.config.js`, which only loads them when
no file/env pack is configured. Without the flag you trade all ~800 live cameras
for the handful in your file. With it, your pack is merged on top and wins on
duplicate IDs.

## Packs here

| File | Cameras | Live? |
|---|---|---|
| `cctv_sources.austin.json` | Austin | mirrors the live Austin pack |
| `cctv_sources.shinjuku.json` | 3, Tokyo | **No** — sample `.mp4` clips |
| `cctv_sources.kualalumpur.json` | 8, Kuala Lumpur | **No** — see below |

## Why Kuala Lumpur is a pilot pack and not a live feed

The live packs (Austin, Caltrans, TfL) work because those agencies publish
**geocoded camera catalogs under open terms**. Kuala Lumpur has no equivalent,
checked 2026-09-13:

- **DBKL / KLCCC** advertises 5,000 cameras; the public page exposes 3, all
  offline (`rtsp-flv-offline-container`), with no coordinates and no API.
- **LLM (highway authority)** has a working endpoint —
  `/awam/cctv1?highway=<CODE>` returns `{file_name, image_url, url,
  location_name}` — but it carries **no latitude/longitude**, its image URLs are
  signed and expire in about two minutes, it sits behind a **reCAPTCHA**, and it
  returns 3 cameras for all of PLUS. The older `/Cctv` endpoint that did return
  coordinates is dead (404) and its page code points at `192.168.25.19`, a
  private LAN address.
- **data.gov.my** has no CCTV dataset; its transport entries are GTFS only.

The missing coordinates are the blocker that matters: the layer projects each
camera *into* the 3D scene, so it needs lat/lon plus a pose. A feed of unplaced
JPEGs cannot be rendered no matter how the access questions are resolved.

## How this pack was built

Every number is measured, not guessed:

- **Positions** are real `highway=traffic_signals` nodes in central KL from
  OpenStreetMap (195 exist in the bbox; 8 were chosen for spread), with street
  names resolved from the named ways within 30 m of each node.
- **`groundElevationM`** is the **orthometric** elevation from the app's own
  `/api/terrain/heights` proxy at each exact point (37–55 m across the set).
  Note this field is orthometric, not ellipsoidal — see `cctv.js`.
- **`headingDeg`** and **`rangeM`** are great-circle bearings and distances
  computed to a real landmark (Petronas Twin Towers, Menara Kuala Lumpur,
  Dataran Merdeka, Masjid Jamek), so each camera points at something.

`pitchDeg`, `fovDeg`, and `mountHeightM` are plausible mast-camera values, not
survey data — drag the in-scene gizmo to calibrate.

## Adding your own city

Copy any pack and match the schema in `normalizeSourceItem` (`vite.config.js`).
Required for a camera to render: `id`, `lat`, `lon`, plus a pose
(`headingDeg`, `pitchDeg`, `fovDeg`, `rangeM`, `mountHeightM`,
`groundElevationM`). Set `sourceKind: "pilot"` and `poseSource: "curated"` so
the panel badge stays honest about what the operator is looking at.

Without a `url` that serves frames, cameras fall back to Google Street View at
the given pose (needs a Google key) and then to a synthetic placeholder — which
is why a pilot pack still shows real imagery of the right junction.

# Tools

CLI scripts for fetching, rendering, and reprojecting geospatial imagery. All tools read the Google Maps API key from `.env` automatically.

Output files go to `output/` by default (gitignored).

When invoking these tools from a separate project, set `GEV_PROJECT_ROOT` to its
absolute directory. Environment files, dependencies and relative output paths
resolve there; bundled rendering HTML stays with the tool. The same setting is
supported by `dev-fresh.sh`, `dev-secure.sh`, `opensky-import-client.sh` and the
setup doctor. Without it, paths continue to resolve from this repository.

## Prerequisites

- Node.js (via `mise`)
- `sharp` and `puppeteer` (devDependencies — `npm install`)
- Google Maps API key in `.env` as `GOOGLE_MAPS_API_KEY`
- APIs enabled on your Google Cloud project: **Map Tiles API**, **Street View Static API**

---

## sat-ortho.mjs

Stitches satellite tiles from the Map Tiles API into a single ortho image centered on a lat/lon.

```sh
# 2K ortho at zoom 21 (~6.4 cm/pixel, ~132m coverage)
node tools/sat-ortho.mjs --lat 30.266476 --lon -97.73719

# Zoom 20 for wider coverage (~264m), or zoom 22 for max detail (~3.7 cm/pixel)
node tools/sat-ortho.mjs --lat 30.266476 --lon -97.73719 --zoom 20 --size 2048
node tools/sat-ortho.mjs --lat 30.266476 --lon -97.73719 --zoom 22 --size 2048
```

| Option | Default | Description |
|--------|---------|-------------|
| `--lat` | — | Center latitude (required) |
| `--lon` | — | Center longitude (required) |
| `--zoom` | 21 | Tile zoom level (max typically 22) |
| `--size` | 2048 | Output square size in pixels |

Reports GSD, ground coverage, and NW/SE corner coordinates for georeferencing.

---

## streetview-headings.mjs

Fetches 8 Street View static images (one per compass heading) at a location, with optional first-order neighbor traversal.

```sh
# 8 images at the intersection
node tools/streetview-headings.mjs --lat 30.266476 --lon -97.73719

# Include all first-order neighbor locations (auto-deduped)
node tools/streetview-headings.mjs --lat 30.266476 --lon -97.73719 --neighbors

# Custom FOV and pitch
node tools/streetview-headings.mjs --lat 30.266476 --lon -97.73719 --fov 120 --pitch -10
```

| Option | Default | Description |
|--------|---------|-------------|
| `--lat` | — | Latitude (required) |
| `--lon` | — | Longitude (required) |
| `--fov` | 90 | Field of view in degrees (10-120) |
| `--pitch` | 0 | Camera pitch (-90 to 90) |
| `--size` | 640x640 | Image size (max 640 per axis) |
| `--step` | 45 | Heading step in degrees |
| `--neighbors` | off | Also fetch images from nearby Street View locations |

The `--neighbors` flag queries Google's panorama metadata for linked locations, deduplicates them by pano ID via the metadata API, and fetches 8 heading images from each unique neighbor within 15m.

---

## streetview-panorama.mjs

Fetches and stitches a full equirectangular panorama from the Map Tiles API (Street View tiles endpoint).

```sh
# Default zoom 3 → 4096x2048 panorama
node tools/streetview-panorama.mjs --lat 30.266476 --lon -97.73719

# Max resolution (zoom 5 → up to 16384x8192)
node tools/streetview-panorama.mjs --lat 30.266476 --lon -97.73719 --zoom 5
```

| Option | Default | Description |
|--------|---------|-------------|
| `--lat` | — | Latitude (required) |
| `--lon` | — | Longitude (required) |
| `--zoom` | 3 | Tile zoom 0-5 (higher = larger pano) |
| `--radius` | 50 | Search radius in meters for nearest panorama |

Output is a standard equirectangular JPEG suitable as input for `pano-pinhole.mjs`.

---

## pano-pinhole.mjs

Reprojects an equirectangular panorama into pinhole (perspective) camera views. Uses inverse mapping with bilinear interpolation — every output pixel is sampled from the panorama, so there are no holes.

```sh
# Single view: looking west, 90 deg FOV, 1920x1080
node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --heading 270 --hfov 90

# All 8 compass headings from one panorama
node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --all --hfov 90

# 2K output with narrow FOV
node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --heading 180 --hfov 60 --width 2560 --height 1440

# Specify focal length instead of FOV
node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --heading 90 --focal 2000

# 12 views at 30-degree steps
node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --all --step 30 --hfov 90
```

| Option | Default | Description |
|--------|---------|-------------|
| `--input` | — | Equirectangular panorama JPEG (required) |
| `--heading` | 0 | Compass heading (0=N, 90=E, 180=S, 270=W) |
| `--pitch` | 0 | Pitch in degrees (positive=up) |
| `--roll` | 0 | Roll in degrees (positive=clockwise) |
| `--hfov` | 90 | Horizontal field of view in degrees |
| `--focal` | — | Focal length in pixels (overrides `--hfov`) |
| `--width` | 1920 | Output width |
| `--height` | 1080 | Output height |
| `--all` | off | Render all compass headings (ignores `--heading`) |
| `--step` | 45 | Heading step for `--all` mode |

Reports horizontal, vertical, and diagonal FOV plus equivalent focal length.

---

## cesium-render.mjs

Renders a CesiumJS 3D view to JPEG via headless Chromium with Google Photorealistic 3D tiles. Requires SwiftShader (no GPU).

```sh
# Look-at mode: camera looks at a target point from above
node tools/cesium-render.mjs --lookat-lat 30.266476 --lookat-lon -97.73719 --heading 180 --pitch -30 --height 25

# Top-down view at 80m
node tools/cesium-render.mjs --lookat-lat 30.266476 --lookat-lon -97.73719 --pitch -90 --height 80 --fov 90

# 2K output
node tools/cesium-render.mjs --lookat-lat 30.266476 --lookat-lon -97.73719 --heading 180 --pitch -30 --height 25 --width 2560 --height-px 1440

# Direct mode: camera placed at coordinates
node tools/cesium-render.mjs --lat 30.266476 --lon -97.73719 --heading 270 --pitch -15 --height 8
```

| Option | Default | Description |
|--------|---------|-------------|
| `--lat/--lon` | — | Camera position (direct mode) |
| `--lookat-lat/--lookat-lon` | — | Target to look at (lookat mode) |
| `--heading` | 0 | Compass heading |
| `--pitch` | -10 | Camera pitch (must be negative in lookat mode) |
| `--height` | 8 | Meters above ground |
| `--fov` | 60 | Vertical field of view |
| `--width` | 1280 | Image width |
| `--height-px` | 720 | Image height |
| `--sse` | 2 | Screen-space error (lower = sharper, slower) |
| `--timeout` | 30 | Max wait in seconds |

Uses progressive SSE refinement and automatic ground-height sampling. Street-level views are limited by Google's photogrammetry tile resolution.

---

## Typical Workflow

```sh
# 1. Get a satellite ortho of an intersection
node tools/sat-ortho.mjs --lat 30.266476 --lon -97.73719 --zoom 21

# 2. Fetch a 4K panorama at the same location
node tools/streetview-panorama.mjs --lat 30.266476 --lon -97.73719

# 3. Extract 8 pinhole views from the panorama
node tools/pano-pinhole.mjs --input output/panorama_30.266476_-97.73719.jpg --all --hfov 90

# 4. Also grab the Street View static API versions for comparison
node tools/streetview-headings.mjs --lat 30.266476 --lon -97.73719

# 5. Render a 3D view of the same location from above
node tools/cesium-render.mjs --lookat-lat 30.266476 --lookat-lon -97.73719 --pitch -90 --height 50 --fov 90 --width 2560 --height-px 1440
```

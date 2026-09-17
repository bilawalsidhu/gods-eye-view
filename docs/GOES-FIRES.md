# Keyless GOES fire/hot spot

The Active Fires layer has two backends behind one contract. NASA FIRMS is
preferred when a server-side `FIRMS_MAP_KEY` is configured. Without a key the
layer used to be empty; it now falls back to the **NOAA GOES-R ABI Level 2 Fire
Detection** product (`ABI-L2-FDCF`), read directly from the public GOES S3
buckets. No API key, token or account is involved.

## Why GOES instead of keyless MODIS/VIIRS

MODIS (`MOD14`/`MYD14`) and VIIRS (`VNP14IMG`) active-fire products are
distributed through NASA LAADS/LP DAAC and require an Earthdata Login token for
programmatic download, even though the data are public. The FIRMS web services
require a free `MAP_KEY`; the daily HTTPS files require an Earthdata session.
There is no official AWS Open Data bucket for them.

The GOES ABI buckets _are_ AWS Open Data: anonymous access, `us-east-1`, not
requester-pays. That makes GOES the only route that is genuinely keyless.

The trade-off is geometric. GOES is geostationary, so it images the full disk
every ~10 minutes and catches fires much sooner than a twice-daily polar
overpass — but at ~2 km at the sub-satellite point (coarser toward the limb) and
only over the Americas and adjacent oceans. VIIRS is ~375 m. The two are
complementary, which is why FIRMS still wins when its key is present.

## Data path

```
noaa-goes19.s3.amazonaws.com/ABI-L2-FDCF/YYYY/DDD/HH/OR_ABI-L2-FDCF-M6_G19_s…_e…_c….nc
        │  (anonymous HTTPS, ~2 MB HDF5)
        ▼
server/providers/goes-fires.js     list latest key → download → cache (~10 min)
        │
        ▼
server/providers/goes/fireGrid.js  HDF5 decode + ABI projection + detection
        │
        ▼
GET /api/goes-fires                FIRMS-shaped rows
        │
        ▼
src/layers/firms/source.js         fallback when /api/firms answers 503 no_key
        │
        ▼
existing fire layer                adapt → cards → render (unchanged)
```

GOES-16 and GOES-17 are decommissioned and produce no 2026 data. The active
satellites are **GOES-19 (East, `lon0 = -75`)** and **GOES-18 (West,
`lon0 = -137`)**, configurable through `GOES_FIRE_SATELLITES`.

## Finding the newest granule

The `s<timestamp>` field in the key is the scan start and does not land on the
10-minute boundary (e.g. `s20262570000215` = 00:00:21.5Z), so the key cannot be
derived by rounding the clock. The provider lists the current hour prefix with
`?list-type=2&prefix=ABI-L2-FDCF/YYYY/DDD/HH/&max-keys=1000` and takes the last
key, walking back an hour at a time when the prefix is empty.

## Decoding and detection

The granule is HDF5 (NetCDF-4), read with `h5wasm` — a WASM build of HDF5 that
needs no native toolchain. The file carries `Mask`, `Power`, `Temp`, `Area`,
`DQF`, the `x`/`y` scan angles and `goes_imager_projection`. Scale factors,
offsets and fill values are read from the file rather than hardcoded.

A pixel is a fire when **`Power > 0`**. This is checkable against the granule's
own aggregates: on the 2026-09-14 00:00Z GOES-19 granule, `Power > 0` selects 83
pixels and filtering `DQF == 0` leaves exactly 79 — the value of the file's
`total_number_of_pixels_with_fire_radiative_power`. `Temp` valid pixels (59)
match `total_number_of_pixels_with_fire_temperature` the same way.

`Mask` is a bit field describing scene classification. Its class semantics are
**not** reimplemented here: the raw value is passed through, because guessing the
bit meanings would silently mislabel detections.

### Projection

The product ships no `Lat`/`Lon` variables, so the ABI fixed grid is inverted to
lat/lon using `perspective_point_height`, `semi_major_axis`, `semi_minor_axis`
and `longitude_of_projection_origin`. Note that
`longitude_of_projection_origin` is in **degrees** while the projection formula
works in radians — mixing them yields longitudes near −4300°. Disk corners
resolve off-earth, as expected for a geostationary disk.

## Confidence

FDCF has no confidence category like FIRMS. `DQF` is mapped to the vocabulary
the layer already understands — `h` (DQF 0), `n` (DQF 1), `l` (DQF 2 or other).
The mapping is a quality tier derived from `DQF`, not a FIRMS confidence value,
and is documented as such at the mapping site. Rows are emitted with the string
form because the existing adapter (`src/data/firmsAdapt.js`) interprets numeric
confidence as the MODIS 0–100 scale and would divide a 0–1 value by 100.

## Attribution

NOAA GOES data are U.S. public domain. The credit is registered under the
`goes-fires` key in `src/data/dataCredits.js` and the layer's source label names
both backends. `getStats()` reports which backend answered through `provider`.

## Limitations

- `FDCC` (CONUS) and `FDM1`/`FDM2` (mesoscale) products are not used — only the
  full-disk `FDCF`.
- GOES coverage stops at the limb; it cannot see fires outside the Americas and
  adjacent oceans.
- Only the newest granule per satellite is used; there is no multi-scan
  temporal compositing or persistence filter.
- `Mask` class semantics are passed through undecoded.

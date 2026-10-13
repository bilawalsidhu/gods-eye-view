# US Census Bureau counties pack

County and county-equivalent outlines for area annotations ("outline Travis
County", "outline Orleans Parish"), read by `src/data/adminBoundaries.js`.

| File | Source dataset | Features |
|------|----------------|----------|
| `counties.json` | `cb_2025_us_county_5m` (cartographic boundary file, 1:5,000,000) | 3,235 |

**Source:** U.S. Census Bureau cartographic boundary files,
<https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_county_5m.zip>
(SHA-256 `faec522080681e79be5be435c981009a77891206ff8a7f1d142f3bf5da9ebd74`),
fetched 2026-09-25. Covers the 50 states, the District of Columbia, Puerto
Rico and the Island Areas (American Samoa, Guam, the Northern Mariana Islands,
the US Virgin Islands).

**License:** public domain — a work of the U.S. Government (17 U.S.C. § 105).
No attribution is required; the app credits the U.S. Census Bureau. See
DATA_SOURCES.md.

**Regenerate:** `node scripts/build-admin-packs.mjs --only counties`
downloads the pinned zip (to the system temp directory, or `--cache <dir>`),
checks its SHA-256, reads the shapefile and rewrites the pack byte for byte.
Parameters are in the script's `PARAMS` and in the pack's `meta.curation`.

**Schema:** `meta` (source, URL, hash, license, curation) and `features[]`
with `name` (`NAME`), `full` (`NAMELSAD`, e.g. "Travis County"), `lsad` (the
county word: County, Parish, Borough, Census Area, Municipality, city, …),
`state` (`STATE_NAME`), `st` (`STUSPS`), `geoid` (`GEOID`) and `polygons`.
`polygons` is a list of parts, largest first, each `[outer, ...holes]`; every
ring is open and stored as integers in units of 10^-4 degrees, the first
vertex absolute and each later one as a `[dLon, dLat]` delta.

**Curation:**

- Shapefile rings are grouped into parts (clockwise outers) and holes
  (counter-clockwise rings, assigned to the outer that contains them), so an
  independent city inside a county (Fairfax city in Fairfax County) is a hole.
- Douglas-Peucker per ring at 0.003 × √(county area in km²) km, clamped to
  0.0005°–0.01° (Travis County ≈ 0.0014°); coordinates rounded to 4 decimals.
- Parts under 1 km² or under 0.1% of the county's largest part are dropped;
  holes under 1 km² are dropped. Outers are counter-clockwise, holes
  clockwise.
- Result: 1,541,464 bytes (533,326 with gzip -9); 3,524 parts, 18 holes,
  139,904 vertices.

# US Census Bureau places pack

City, town, village and census designated place (CDP) outlines for area
annotations ("outline Austin", "outline Springfield, Illinois"), read by
`src/data/placeBoundaries.js`. One file per state or territory, fetched when
an ask needs that state (files under 4 KB are inlined into the app bundle by
the bundler).

| File | Contents |
|------|----------|
| `index.json` | source, schema, curation, and each state's code, FIPS code, name, place count and box |
| `<ST>.json` | the places of one state (USPS code) |
| `files.js` | every file's URL, so bundlers emit them (generated) |

**Source:** U.S. Census Bureau cartographic boundary files,
<https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_place_500k.zip>
(SHA-256 `ce0e4019ecd4123d03d53aaa936eed0459b82e3e14b89a3dcd4d5e8b3308627d`).
32,629 places in the 50 states, the District of Columbia, Puerto Rico and the
Island Areas: 19,733 incorporated places and 12,896 CDPs.

**License:** public domain — a work of the U.S. Government (17 U.S.C. § 105).
See DATA_SOURCES.md.

**Regenerate** (requires Python with shapely==2.1.2 on GEOS 3.13.1):
`node scripts/build-census-places.mjs [--python <exe>]` downloads the pinned
zip (to the system temp directory, or `--cache <dir>`), checks its SHA-256,
rewrites the pack and runs `scripts/pack_geometry.py repair census`; the
result is the same byte for byte. `python scripts/pack_geometry.py check
census` checks the shipped pack.

**Schema:** each state file has `st`, `state`, `fips` and `features[]` with
`geoid`, `name` (`NAME`), `alt[]` (everyday names of consolidated
governments, e.g. "Nashville"), `full` (`NAMELSAD`), `lsad` (city, town,
village, CDP, …), `cdp` (census designated place), `d` (decimals when not
4) and `polygons`. `polygons` is a list of parts, largest first, each
`[outer, ...holes]`; every ring is open and stored as integers in units of
10^-4 degrees (10^-`d` when present), the first vertex absolute and each
later one as a `[dLon, dLat]` delta.

**Curation:** the county pack's simplification (see
`../us_census_counties/README.md`), keeping triangles. A place whose
simplified rings would cross is simplified again at half the tolerance, then
at 5 or 6 decimals. Every place is then a valid MultiPolygon under GEOS in
the pack's integer units (the rest are repaired and snapped back to the
grid), with its largest part first.

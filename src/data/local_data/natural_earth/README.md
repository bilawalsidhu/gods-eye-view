# Natural Earth packs

Offline named-region polygons for the voice-annotation resolver
(`src/data/naturalEarthRegions.js`) — "outline the Alps" resolves to the real
range geometry with no network dependency.

| File | Source dataset | Features |
|------|----------------|----------|
| `regions.json` | `ne_10m_geography_regions_polys` (ranges, deserts, plateaus, peninsulas, islands, …) | 1,046 named |
| `marine.json` | `ne_10m_geography_marine_polys` (seas, gulfs, straits, bays, …) | 292 named |
| `countries.json` | `ne_10m_admin_0_countries` (countries) | 256 |
| `states_provinces.json` | `ne_10m_admin_1_states_provinces` (states, provinces and other first-level units) | 4,587 named |

**Source:** Natural Earth 10m physical vectors, via the canonical
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
GitHub repo, commit `ca96624a56bd078437bca8184e78163e5039ad19` (fetched
2026-07-28T01:36:39Z — exact provenance is in each file's `meta` header).

**License:** public domain (https://www.naturalearthdata.com/about/terms-of-use/).
No attribution legally required; we credit "Made with Natural Earth" anyway.
See DATA_SOURCES.md.

**Curation** (script not committed — parameters recorded in `meta.curation`):

- Named features only; the `Dragons-be-here` joke feature ("Null Island") dropped.
- Outer rings only (holes are irrelevant at country-scale outline zoom).
- Douglas-Peucker simplification at 0.01°, coordinates rounded to 3 decimals
  (~110 m), rings stored open (no closing duplicate vertex).
- MultiPolygon crumbs under 20 km² dropped (largest part always kept);
  rings that survive with fewer than 8 distinct vertices are midpoint-densified
  (shape-identical) so every ring has ≥8 vertices.
- Zero-area sliver artifacts dropped. Two marine features are ONLY slivers in
  the source and are therefore absent: **Drake Passage** and **Luzon Strait**.
- Result: 7.3 MB source → 2.5 MB pack (budget ≤3 MB, enforced by
  `src/data/naturalEarthRegions.test.mjs`).

Duplicate names exist upstream (two "Cordillera Oriental", a sliver + real
"Canadian Shield", …); the lookup module resolves ties by largest area.

## States and provinces (`states_provinces.json`)

Worldwide first-level administrative units for area annotations ("outline
Texas", "outline Bavaria"), read by `src/data/adminBoundaries.js`.

**Source:** `geojson/ne_10m_admin_1_states_provinces.geojson` from
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
at commit `ca96624a56bd078437bca8184e78163e5039ad19` (SHA-256
`22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5`), fetched
2026-09-25. `geojson/ne_10m_populated_places_simple.geojson` from the same
commit (SHA-256
`fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f`) is read
only to mark ambiguous names; none of it is bundled.

**License:** public domain, as above.

**Regenerate:** `node scripts/build-admin-packs.mjs --only admin1` downloads
the pinned files (to the system temp directory, or `--cache <dir>`), checks
their SHA-256 and rewrites the pack byte for byte. Parameters are in the
script's `PARAMS` and in the pack's `meta.curation`.

**Schema:** `meta` (source, URLs, hashes, license, curation) and `features[]`
with `name`, `nameEn` (when it differs), `alt[]` (Latin-script `name_alt`
variants and abbreviations), `postal`, `type` (`type_en`), `rank`
(`min_label`), `country` (`admin`), `iso2`, `iso` (ISO 3166-2), `amb[]`,
`ambAbroad[]`, `cityState`, `label` ([lon, lat] label point) and
`polygons`. `polygons` is a list of parts, largest first, each
`[outer, ...holes]`; every ring is open and stored as integers in units of
10^-3 degrees (10^-`d` when a feature carries `d`), the first vertex absolute
and each later one as a `[dLon, dLat]` delta.

**Curation:**

- The 7 unnamed features and 2 degenerate Nauru districts are dropped
  (4,596 → 4,587).
- Douglas-Peucker per ring at 0.004 × √(unit area in km²) km, clamped to
  0.005°–0.02° (Texas ≈ 0.02°, Bavaria ≈ 0.01°); coordinates rounded to
  3 decimals. The 75 units too small to survive (Maldives atolls, Malta's
  councils) keep 4 decimals at 0.001° (`d: 4`); 3 smaller still (Vatican
  City) keep their source rings at 5 decimals (`d: 5`).
- Parts under 20 km² or under 0.03% of the unit's largest part are dropped;
  holes under 20 km² are dropped. Outers are counter-clockwise, holes
  clockwise.
- `amb` lists names that are also a country (`admin`/`geonunit` of any
  unit), a populated place of 200,000+ (`pop_max`) inside the unit's box
  when the unit is larger than 1,000 km², or a populated place of 50,000+
  elsewhere in the same country; `ambAbroad` lists names shared only with a
  populated place of 50,000+ in another country. `cityState` marks a unit of
  at most 1,000 km² that contains its namesake city (Berlin, Vienna, Paris).
  548 units carry `amb`, 108 `ambAbroad`, 138 `cityState`.
- Result: 3,648,916 bytes (1,260,545 with gzip -9); 6,492 parts, 80 holes,
  407,339 vertices.

## Countries (`countries.json`)

Natural Earth 10m admin-0 countries, public domain under the terms above.
Source: `geojson/ne_10m_admin_0_countries.geojson` at the same pinned commit;
SHA-256 `239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255`.
Regenerate with `node scripts/build-admin-packs.mjs --only countries`.
Uses the state/province encoding and simplification, retaining parts of at least
20 km² and 0.003% of the largest part (including Alaska and Hawaii); the largest
part always stays. Holes under 20 km² are dropped.
Includes England, Scotland, Wales and Northern Ireland from
`ne_10m_admin_0_map_units.geojson` at the same commit (SHA-256
`57da82be755f4afccd8f3b14251bb2752f5df1395f47d2d86f817470c4a48862`).
Result: 945,843 bytes; 260 features, 2,088 parts, 122,788 vertices.

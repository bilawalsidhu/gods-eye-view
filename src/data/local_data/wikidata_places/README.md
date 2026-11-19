# Wikidata places detail tiles

Smaller towns and villages, below the cut-off of the cities pack
(`../wikidata_cities`), for "places nearby" around one picked or named spot. Read by `placesNear` in `src/data/wikidataCities.js`, and by `findPlace`
when asked to look for a small place by name near the view: a place of that
name in view, or close to it, comes before a bigger city of the name far
away. The app reads these files; it does not call Wikidata or any place
service for them.

| File | Contents |
|------|----------|
| `index.json` | `meta` (build time, population range, counts) and `tiles`: each tile key with its row count |
| `<lat>_<lon>.json` | One 5 x 5 degree tile, named by its south-west corner (`30_-100` covers 30 to 35 N, 100 to 95 W) |
| `files.js` | Generated: each tile's URL, so a bundler ships every file. Imported on the first lookup |

Each row is `[name, lat, lon, population, country, wikidata]`, the same
columns as the cities pack. Tiles without any place have no file and no
entry in the index.

**Loading:** nothing here loads with the app. A lookup reads `files.js` and
the index once, then only the tiles its search box touches (one for a short
radius well inside a tile, more near tile edges and for wider searches),
once each. A lookup reaches 500 km at most (`PLACE_TILE_KM`; the search box
asks for 150 km at most), so one asked for a wider radius reads only the
tiles around its centre: at most one
tile past the centre's own on each side, a few more columns toward the
poles, and never all 732. Cities still count to the full radius. At most
64 tiles are kept in memory, the least recently used
dropped first. Rows whose name has no letter (one row, `380` in Nicaragua) are
dropped when a tile is read.

**Source:** Wikidata, read once from the Wikidata Query Service on
2026-11-11 (`index.json` `meta.built`): human settlements with a population
from 1,000 up to (not including) 15,000, less the 1,084 items the cities
pack already holds (an item can state one population under 15,000 and
another over it) and 1,272 second listings of one place (the same folded
name and country within 3 km; the larger stays): 137,662 places in 732
tiles. The
script that wrote the shipped files was not kept; the `--tiles` mode below
applies the cities pack's settlement filters to that population range.

**License:** CC0 1.0 (https://www.wikidata.org/wiki/Wikidata:Licensing). No
attribution is legally required; the app credits "City, town and village
names from Wikidata (CC0)" as a courtesy once a name from the pack is shown.

**Rebuild:**
`node scripts/build-wikidata-cities.mjs --tiles --min-population 1000 --max-population 15000`.
It writes only to this folder (tiles, `index.json`, `files.js`, through
`scripts/wikidataPlaceTiles.mjs`) and leaves `../wikidata_cities` alone. It
runs one query at a time with pauses and takes a long while. The new files
are all written before tiles that the new build has no rows for are
removed, and `meta.built` keeps its earlier date when no tile and
nothing else in `index.json` changed.

**Reproducibility:** the step from rows to files is checked offline:
`src/tooling/wikidataPlaceTiles.test.mjs` sorts the shipped rows as the
build does, leaves out the cities pack's ids, and gets every shipped file
back byte for byte. The 1,084 overlapping rows and the 1,272 near twins
were removed from the first build's rows this same way, offline. The sorted,
filtered rows (`JSON.stringify` of the array) have sha256
`4669a523d8f9ae486a42976ca8dc5694f2d13678b48b418c165fad6fb343861e`.

**Query:** `scripts/build-wikidata-cities.mjs` asks for each population band

```sparql
SELECT ?item ?pop ?coord ?type WHERE {
  ?item wdt:P1082 ?pop . FILTER(?pop >= LOW && ?pop < HIGH)
  ?item wdt:P625 ?coord ; wdt:P31 ?type .
}
```

keeps items typed as a subclass of human settlement (Q486972), then reads
English labels, countries (P17/P297) and dissolution dates (P576) in batches.
This is the query the `--tiles` mode runs; the text of the first build's own
query was not kept, so that it was the same cannot be shown. The query itself
was not re-run for this check. Wikidata changes daily, so a rebuild gives a
different set of rows, and that the shipped rows match what this script's
query returned on the build date cannot be proven offline.

**Limits:** only places for which Wikidata states a population and has an
English label, so coverage differs a lot between countries. Populations
differ in date and definition. Tile sizes are uneven: most hold a few dozen
places or fewer (median 13), the densest (`20_85`) 14,469. Rows may include
former or depopulated settlements, and 690 rows have no country code (left
in: an owner decision). A few names are places that are not settlements as
such ("Historic Centre of Salvador da Bahia", "Old Airport" in Brunei,
"Polokwane Ext 44"); no rule small enough to be safe removes them, so they
stay.

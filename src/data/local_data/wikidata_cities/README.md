# Wikidata cities pack

World cities and towns for naming a spot (the nearest city), the places
around it and finding a place by name, read by `src/data/wikidataCities.js`. The app reads this file; it
does not call Wikidata or any place service for these.

| File | Contents |
|------|----------|
| `cities.json` | Human settlements with coordinates and a population at or above the cut-off (see `meta.minPopulation`), largest first |

Each row is `[name, lat, lon, population, country, wikidata]`: the English
label, coordinates to three decimals, the largest stated population, the
ISO 3166-1 alpha-2 country code (empty when Wikidata gives none) and the
Wikidata id.

**Source:** Wikidata, read once from the Wikidata Query Service by
`scripts/build-wikidata-cities.mjs`. The build time and row count are in the
file's `meta` header.

**License:** CC0 1.0 (https://www.wikidata.org/wiki/Wikidata:Licensing). No
attribution is legally required.

**What is left out:** metropolitan areas, urban agglomerations, conurbations
and similar groupings of settlements, so a view is named after the city
rather than the area around it (an item of a narrower grouping kind that is
also a city stays: Istanbul is a metropolitan municipality and a megacity);
places that no longer stand (former entities, ghost towns, abandoned
villages, archaeological sites) unless they are also a living settlement;
and places Wikidata states as dissolved or abolished (P576) where another
place within 15 km still names the spot. A dissolved unit with nothing
else near it stays: many of Vietnam's provincial cities ended as units in
2025 and still stand under their names. Also left out: places below the population cut-off and
places without an English label.

**Rebuild:** `node scripts/build-wikidata-cities.mjs [--min-population 15000]`.
The build runs one query at a time with pauses and honours the service's
Retry-After; it takes about ten minutes. It fails if a short list of
well-known cities is missing from the result, or a known grouping gets in.
`meta.built` keeps its earlier date when the rows are unchanged.

**Limits:** populations are whatever Wikidata states and differ in date and
definition between places (city proper, municipality, urban district). Some
districts and suburbs appear as their own rows.

**Finding a place by name:** `findPlace` takes the nearest place of the name
within 150 km of the view, else the largest city of the name. When asked,
the smaller places of `../wikidata_places` near the view count too, so a
village in view comes before a bigger namesake far away.

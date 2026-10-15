# Argentina dams — IGN Dique

FUENTE: Instituto Geográfico Nacional de la República Argentina.

The `Dique` point dataset supplements the existing **Dams** layer. These are
mapped structures, not live operational, water-level, or safety observations.
The upstream WFS response contains 125 features. The original properties,
including `fdc` (compilation source) and `sag`, are retained under `ign`.
Unnamed records remain unnamed. No generating capacity is inferred.

- Source: `ign:puntos_de_aguas_continentales_BH051`, WFS 1.0.0, EPSG:4326.
- Catalog: https://www.ign.gob.ar/NuestrasActividades/InformacionGeoespacial/CapasSIG
- Snapshot retrieved: **2026-10-15**. The source does not supply an update date;
  the retrieval date and WFS response timestamp are not substituted for one.
- Original response, URL, checksum and dates: `source.geojson`, `source.json`.
- Runtime: `dams.geojsonl`; rebuild offline with
  `node scripts/build-argentina-dams.mjs` from the repository root.
- `deduplication.json` records every omitted point and its retained OSM/IGN
  counterpart. A point inside an existing dam polygon, a same-name feature
  within 1.5 km, or coincident points within 5 m are treated as duplicates.
  Name matching folds accents and generic dam prefixes. Different names at
  nearby coordinates are retained unless their geometry establishes overlap.
- The 704 original OSM/OpenInfraMap records remain in their own directory,
  unmodified and under ODbL. The IGN supplement is a separate data source;
  it is not relicensed as ODbL or MIT.

## Reuse terms

IGN's [terms](https://www.ign.gob.ar/descargas/tyc1.html), checked 2026-10-15,
permit copying, redistribution, modification and combination with attribution.
Retain source dates and reuse metadata, share the downloaded data freely and
without charge, and do not imply IGN participation, sponsorship or endorsement.
Commercial use is permitted only for derived works using the information as an
input to a new product. The data remains subject to those terms and IGN's
disclaimer; the repository's MIT code license does not apply to it.

When refreshing, download the linked WFS response, review its changes and terms,
update `source.json` with its checksum and provenance, rebuild, and review the
deduplication report. Do not silently redate the underlying observations.

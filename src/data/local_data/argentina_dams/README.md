# Argentina dams — IGN Dique

FUENTE: Instituto Geográfico Nacional de la República Argentina.

The `Dique` point dataset supplements the existing **Dams** layer. These are
mapped structures, not live operational, water-level, or safety observations.
The upstream WFS response contains 125 features; 121 enter the runtime pack. The original properties,
including `fdc` (compilation source) and `sag`, are retained under `ign`.
Unnamed records remain unnamed. No generating capacity is inferred.

- Source: `ign:puntos_de_aguas_continentales_BH051`, WFS 1.0.0, EPSG:4326.
- Catalog: https://www.ign.gob.ar/NuestrasActividades/InformacionGeoespacial/CapasSIG
- Snapshot retrieved: **2026-10-15**. The source does not supply an update date;
  the retrieval date and WFS response timestamp are not substituted for one.
- Original response, URL, checksum and dates: `source.geojson`, `source.json`.
- Runtime: `dams.geojsonl`; rebuild offline with
  `node scripts/build-argentina-dams.mjs` from the repository root.
- `deduplication.json` records omitted duplicates and their retained OSM/IGN
  counterparts, excluded non-dam features, and nearby unnamed review candidates. A point inside an existing dam polygon, a same-name feature
  within 1.5 km, or coincident points within 5 m are treated as duplicates.
  Name matching folds accents and generic dam prefixes. Different names at
  nearby coordinates are retained unless their geometry establishes overlap.
- The Río Salado record (gid 2575) is excluded because its structured `gna`
  field identifies a flood-defense embankment (`Terraplén de Defensa`). Bañado
  de la Estrella (gid 2512) is also excluded because `gna` identifies a wetland
  (`Bañado`); the untouched source snapshot and audit retain both records.
- Unnamed pairs 2578/2579 (77.9 m) and 2956/2957 (36.1 m) remain separate
  records. Their distinctness is unverified: proximity alone is not sufficient
  to merge two structures. Both pairs are listed in the audit for source review.
- The original OSM/OpenInfraMap records remain in their own directory,
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

## Integration with other dam packs

Both the renderer and analyst source obtain their URL list from
`infrastructureDataUrls`; the shared loader returns `{ features, error }`. The
first URL is required; supplement failures preserve the original OSM dataset and
return an error with the partial features. Partial loads are not cached: analyst
queries retry them and the renderer retries on the next off/on toggle. Main-file
failures and aborts still reject the load.
PR #1009 uses the same URL-list contract for NVE: when combining them, append
both regional URLs to the one supplement list and retain the shared loader.
No NVE data or implementation is included here.

PR #1152 adds two OSM geometries. Rebuild this audit after that data change and
update the displayed combined counts. IGN analyst-count tests derive totals from
the input geometries rather than assuming a fixed OSM count.

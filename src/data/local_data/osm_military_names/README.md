# Military area names

This database is distributed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), separately from the MIT code.
© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
Distribution: [Overture Maps Foundation](https://docs.overturemaps.org/attribution/), base/land_use release **2026-09-23.1**.
OSM snapshots: **2026-09-06**, with two named records from **2026-09-12**.

Selected named military areas; geometry simplified to interior label points,
bounds and area, coordinates rounded and records re-encoded. Names are unchanged.
Rows: `[typedOsmId, name, lon, lat, west, south, east, north, classIndex, areaM2]`.
Labels use five decimal places; bounds use four. Area is measured on the WGS84
ellipsoid. Class indices refer to `classes`. Output SHA-256: [`names.sha256`](names.sha256).

Rebuild (maintainer tool; requires Python and `duckdb==1.5.5`):

```sh
python scripts/build-military-names.py --cache /tmp/military-names
python scripts/build-military-names.py --cache /tmp/military-names --verify
```

The pinned parquet file list and query are in `scripts/military-names-files.json`
and `scripts/military-names.sql`. The first build downloads DuckDB extensions and
scans source columns; subsequent builds reuse the cached selected rows.

## Norway supplement

`norway.json` names military areas that OpenStreetMap maps in Norway without a
name, and places active Norwegian Armed Forces sites that have no mapped
military area at all. It is built from the curated list in
`scripts/military-names-norway.json`, where every row cites a Wikidata item
(CC0) for its name and position. Geometry measurements come from the Geofabrik
extract **norway-261005** (OpenStreetMap, 2026-10-05; MD5
`1d2cfdeb98980fce11b8891d0f9146c0`). Wikidata retrieved **2026-10-07**.
Rows: `[typedOsmId|null, name, lon, lat, west, south, east, north, classIndex,
areaM2, wikidataId]`. A `null` OSM id marks a point-only site; Bodø and Banak
take their bounds and area from the co-located aerodrome. Area here is
spherical (authalic radius). Output SHA-256: [`norway.sha256`](norway.sha256).

The build refuses an OSM object that has gained a name, lost its military
tag, is smaller than a hectare, or lies more than 4 km from its Wikidata
position. The pack never overrides a name OpenStreetMap already has.

```sh
python scripts/build-military-names-norway.py --cache /tmp/military-names-norway
python scripts/build-military-names-norway.py --cache /tmp/military-names-norway --verify
```

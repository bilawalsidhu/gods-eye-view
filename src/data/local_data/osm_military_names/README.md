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

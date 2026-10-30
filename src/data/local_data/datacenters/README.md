# Datacenters

OpenStreetMap-derived datacenter features bundled for the local infrastructure
layer.

- Source: OpenStreetMap contributors
- License: Open Database License (ODbL) 1.0
- Feature count: 4,352
- Runtime file: `datacenters.geojsonl`

The public-release snapshot removes contact-oriented tags such as email, phone,
fax, mobile, and WhatsApp values. The application does not display or depend on
those fields; it uses feature identity, geometry, name, operator, and capacity
metadata. The remaining derived database continues to be distributed under
ODbL 1.0 with the required OpenStreetMap attribution.

The original extraction date and query were not recorded alongside this
snapshot. Future refreshes should record both before replacing the file.

## Norway refresh

Features inside the Geofabrik Norway boundary (`norway.poly`, which includes
Svalbard) were refreshed separately, so this file mixes two vintages: Norway
reflects OSM as of the extract below, everything else the original snapshot.

- Extract: Geofabrik `norway-261005.osm.pbf`, OSM data
  2026-10-05T20:21:35Z, MD5 `1d2cfdeb98980fce11b8891d0f9146c0`
- Filter: `osmium tags-filter nwr/telecom=data_center nwr/building=data_center`
- Contact tags are dropped as above; unchanged features keep their original
  line, so geometry is only rewritten when tags or vertices actually changed.
- Refresh: `python3 scripts/build-datacenters-norway.py --cache <dir>` uses
  Geofabrik's current Norway extract and prints the dated name it used; record
  that name, its OSM timestamp and MD5 here. Requires `osmium-tool`.
- Check: add `--extract <dated name> --verify` to compare without writing.
  Geofabrik keeps only its newest dated extract, so a recorded extract can be
  re-verified only while it is still listed; the MD5 above identifies it.

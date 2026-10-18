- Refresh Norway's datacenters from a Geofabrik OpenStreetMap extract
  (2026-10-05). Troll Housing joins the layer (4,352 features) and four
  Norwegian sites pick up current OSM tags; no site moved or was removed.
  `scripts/build-datacenters-norway.py` reproduces or `--verify`s the merge,
  touching only features inside Geofabrik's Norway boundary, and the dataset
  README records the extract, checksum and filter (trygvehhh, #953).

- Add 121 IGN Argentina dam points to the existing Dams layer and infrastructure
  queries. Preserve the OSM dataset, suppress two overlapping records and one
  flood-defense embankment plus one wetland, and audit nearby unnamed pairs
  without assuming they are duplicates. Query rows identify source, ID and dates; only
  returned rows contribute attribution. A missing IGN supplement preserves OSM
  and remains retryable. Keep IGN reuse terms separate.
  (radianx, #1149).
- Preserve independent NVE provenance when composing regional packs, load repeated URLs once, and test three-source attribution and partial-failure isolation. Document the independent landing order and snapshot count matrix.

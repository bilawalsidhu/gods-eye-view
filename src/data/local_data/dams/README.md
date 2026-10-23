# Dams

Extracted from local decoded OpenInfraMap/PostGIS layers.

Filters: `waterway=dam`, `man_made=dam`, or `building=dam`.

Feature count: 706

Runtime output: `dams.geojsonl`

License: Open Database License (ODbL) 1.0. Keep the OpenStreetMap contributor
attribution and the Open Infrastructure Map source credit when redistributing
this derived database.

The public-release snapshot removes contact-oriented fields and note values
that contain email or phone identifiers. The runtime layer does not display or
depend on those fields. Both `dams.geojson` and the runtime JSONL form carry the
same privacy transform.


## Paraguay additions (2026-10-15)

The existing extract is supplemented with two OpenStreetMap features fetched
through the public OSM API, under the same ODbL 1.0 license:

- Acaray: [way 262532166](https://www.openstreetmap.org/way/262532166), original closed dam outline (stored as a LineString).
- Represa Yacyretá-Apipé: [relation 5671745](https://www.openstreetmap.org/relation/5671745), original dam outline. Its eight outer ways are joined by shared node IDs into one closed polygon; no reservoir or duplicate power-plant footprint is added.

Each feature preserves the OSM name/tags and records its source URL, parent
object version and retrieval date. Relation IDs retain the extract's negative-ID
convention. Node metadata and contributor identifiers are not bundled. This is
a static map inventory, not live generation, reservoir level or dam status.

## Regional integration

The 706 OSM features produce 705 analyst records: existing relation 19953989
(`HE Podlubnik - Centrala`) is a MultiLineString without a supported query point.
Keep #1009's NVE file and #1149's IGN file separate from this ODbL dataset.
The proposed landing order is #1009 → #1152 → #1149; after predecessors land,
reconcile the shared source label and docs without replacing the regional list.
Together the snapshots contain 706 OSM + 4,141 NVE + 121 IGN = 4,968 source
features and 4,967 analyst records. Those are combined expectations, not the
contents of this standalone OSM-only branch.

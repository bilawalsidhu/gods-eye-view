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
depend on those fields.

## OSM API additions

Two dams come from the public OpenStreetMap API rather than the extract:

- Acaray: [way 262532166](https://www.openstreetmap.org/way/262532166), its closed outline of nine nodes.
- Represa Yacyretá-Apipé: [relation 5671745](https://www.openstreetmap.org/relation/5671745), its eight outer ways joined into one closed outline.

Both are under the same ODbL 1.0; the relation keeps the extract's negative ID (-5671745).
Keep both as polygons: the Dams layer skips LineStrings.

The layer puts a polygon's marker at the centre of its bounding sphere. The Yacyretá outline is L-shaped, so its
marker sits about 1.6 km from the outline, over the reservoir.

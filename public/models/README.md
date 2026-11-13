# Bundled 3D Models

Every 3D model shipped in this directory is one of the project's procedural
fleet models under [`fleet/`](fleet/): aircraft, helicopters, ships, buoys,
transit and rail vehicles, and a few other airborne and ground objects. They
are generated from code by the project maintainers, contain no third-party
artwork, and are covered by the repository's [MIT license](../../LICENSE)
like the source code.

| Path | What it holds |
|---|---|
| `fleet/catalog.json` | Every model by name: its file, category, built length, beam and bounds (metres, in Cesium's Z-up model frame: x along the length with the nose toward −X, y across the beam, z up), the clearance below its origin, and its 2D icon class. |
| `fleet/types.json` | Which model draws which vehicle, and at what length: ICAO aircraft and helicopter type codes, ADS-B emitter categories, AIS ship-type and length ranges, GTFS route types, transit modes and rail categories, with the defaults. |
| `fleet/aircraft/`, `fleet/helicopters/`, `fleet/ships/`, `fleet/buoys/`, `fleet/transit/`, `fleet/other/` | The models, one GLB each (EXT_meshopt_compression and KHR_mesh_quantization, vertex colours, no textures). |

How the layers use them:

- Each layer draws a vehicle with the model its type selects, scaled to the
  type's published length (a vessel to its reported AIS length and beam), so
  every model is drawn life size. Ground objects, balloons and obstacles in
  the `other` category are drawn at the size they are built.
- An aircraft model's origin is its axis; it stands that model's scaled
  clearance above the ground. A ship's origin is its waterline, and a transit
  or rail vehicle's the road or rail top (a monorail or gondola is raised by
  its `transit.elevation` entry, for a source that names those modes).
- Transit and rail models carry a `_TINT` vertex attribute that marks where
  the route or category colour is painted.
- The whole set loads once, up front, when a layer that draws it starts; no
  model is fetched while a session runs.

`src/data/fleetModels.js` reads the set and chooses each vehicle's model;
`src/data/fleetModels.test.mjs` checks that every model `types.json` names is
in the catalog and on disk, and that no GLB exceeds 3 MB.

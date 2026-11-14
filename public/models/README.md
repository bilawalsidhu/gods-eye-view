# Bundled 3D Models

Every 3D model shipped in this directory but one is one of the project's procedural
fleet models under [`fleet/`](fleet/): aircraft, helicopters, ships, buoys,
transit and rail vehicles, and a few other airborne and ground objects. They
are generated from code by the project maintainers, contain no third-party
artwork, and are covered by the repository's [MIT license](../../LICENSE)
like the source code. The exception is NASA's model of the ISS, described in
[its own section](#the-iss-model-issglb) below.

| Path                                                                                                      | What it holds                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fleet/catalog.json`                                                                                      | Every model by name: its file, category, built length, beam and bounds (metres, in Cesium's Z-up model frame: x along the length with the nose toward −X, y across the beam, z up), the clearance below its origin, and its 2D icon class. |
| `fleet/types.json`                                                                                        | Which model draws which vehicle, and at what length: ICAO aircraft and helicopter type codes, ADS-B emitter categories, AIS ship-type and length ranges, GTFS route types, transit modes and rail categories, with the defaults.           |
| `fleet/aircraft/`, `fleet/helicopters/`, `fleet/ships/`, `fleet/buoys/`, `fleet/transit/`, `fleet/other/` | The models, one GLB each (EXT_meshopt_compression and KHR_mesh_quantization, vertex colours, no textures).                                                                                                                                 |

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

## The ISS model (`iss.glb`)

One model sits outside the fleet set: `iss.glb`, the International Space
Station drawn by the satellites layer up close. It is not procedural and not
covered by the MIT license. It is NASA's own model of the station, which is
not subject to copyright in the United States
([NASA Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media));
its use does not imply endorsement by NASA. It loads only when the camera
nears the station.

- **Original work:** “International Space Station (ISS) (D) (IGOAL)”, NASA
  Johnson Space Center, Integrated Graphics, Operations and Analysis
  Laboratory, on
  [NASA 3D Resources](https://science.nasa.gov/3d-resources/international-space-station-iss-d-igoal/).
- **Reduction:** from the 96 MB original (2.7 M triangles) to 3 MB (314 k
  triangles): handrails left out; geometry simplified within 15 cm
  (structure) or 40 cm (small details) of the original surface, normals
  rebuilt; normal maps dropped; textures resized to 512 px WebP;
  Draco-compressed.
- **Frame:** every part is baked into one frame in meters (glTF +Y zenith,
  +X port, +Z forward), and the scene root moves the bounding-box centre to
  the origin.
- **Corrections:** NASA's file is a mirror image of the station (port and
  starboard swapped), which is undone; 15 materials NASA marks as blended
  are made opaque, because blended they draw see-through.
- **Moving parts:** parts that move stay separate nodes at the joints NASA
  names (two alpha joints, eight array beta joints, two radiator joints,
  Canadarm2's seven joints, two joints on each Dextre arm, three on the
  Japanese arm). The two Ku-band dishes and three of the four power-module
  radiators, welded into the truss in NASA's file, are cut out by position.

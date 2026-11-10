# Import reference corpus

`reference.json` records Cesium 1.138.0 DataSources in Node with a DOM shim,
canvas pins stubbed and KMZ images resolved locally. It is independent of
`planImport` and checks entity geometry and styles, without rendering pixels.

Record and compare offline from the repository root; no server or browser is
needed. Recording uses the installed Cesium version, saved in the reference:

```sh
node scripts/qa-geo-import-reference.mjs --record
node scripts/qa-geo-import-reference.mjs
```

Recording uses Cesium's `KmlDataSource` and `GeoJsonDataSource` after the import's
sanitization and GeoJSON grounding policy. Files are read from this directory;
packed images use local blob URLs. Comparison uses 0.01 metres for heights,
1e-7 degrees for coordinates and one 8-bit channel (1/255) for colours.
Repeated ring endpoints and ignored short holes are normalized; input winding
is retained. Image overlay order is compared separately, including ties in
document order. Pixel composition and ordering between primitive families
still need browser acceptance.

| File                 | Cases                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `absolute.kml`       | Absolute pins, lines and polygons; positive and negative image heights; raised rotated colour overlay |
| `relative.kml`       | Relative pins, lines, polygons and image overlay                                                      |
| `clamped.kml`        | Clamped heights and tessellation                                                                      |
| `rotations.kml`      | Zero, positive, negative and full turns; a tinted 360-degree span                                     |
| `pole.kml`           | Rotation near and past a pole; polar polygon                                                          |
| `antimeridian.kml`   | Dateline polygon and rotated image                                                                    |
| `holes.kml`          | Ring closure and opposite windings with holes                                                         |
| `short-holes.kml`    | Short and duplicate-corner holes                                                                      |
| `draw-order.kml`     | Negative, positive and equal image orders; plain colour                                               |
| `styles.kml`         | KML colours, line width, icon scale, heading and hot spot                                             |
| `geometries.geojson` | Grounded point, line and polygon                                                                      |
| `large-polygon.kml`  | A raised polygon with 20,000 vertices                                                                 |
| `packed.kmz`         | An icon and a tinted, rotated overlay using a packed PNG                                              |

The corpus checks negative absolute image heights and raised plain-colour
overlays against Cesium. Short holes are skipped on direct record input without
rejecting the whole ground polygon. Raised fills have a 32,768-vertex ceiling
and raised polygons a 128-ring ceiling in `src/data/geoImportLimits.js`;
a repeated closing vertex does not consume triangulation budget. The large
polygon fixture exercises a 20,000-vertex fill within that budget.

# Globe primitives

A layer draws through the globe-engine contract (`src/globe/contract.js`),
not through Cesium or Navara. The contract has three drawing primitives:

- `engine.movers`: things at points;
- `engine.lines`: lines in the air;
- `engine.ground`: fills on the ground.

Each engine implements all three. Cesium's are in `src/globe/cesium/`,
Navara's in `src/globe/navara/`, and the fake engine's in
`src/globe/testing/fakeEngine.js`. The checks every engine must pass are in
`src/globe/testing/contractSuite.mjs`.

## Movers: things at a point

`engine.movers.createSet({ id, kind, capacity, ... })` makes a set of up to
`capacity` instances drawn as one batch. Write them with
`set(index, fields)` and `setCount(n)`, then upload the changes with one
`commit()`.

There are three kinds:

- `sprite`: an image from an atlas, a square of `sizePx`, turned by
  `rotation`;
- `point`: a filled disc with an outline;
- `model`: a glTF in metres, at least `minimumPixelSize` on screen.

Use movers for aircraft, vessels, satellites, cameras, stations: anything
that has a position and is drawn the same size on screen (or as a model).

Instances move every frame without a rebuild. `depthTest` decides whether
the scene hides them. A pick returns the instance's `pickId` when the set is
`pickable`.

## Lines: polylines in the air

`engine.lines.createLine({ id, widthPx, color, ... })` makes one polyline.
You can change its positions, colour and model matrix at any time.

The width is in CSS pixels. The line follows the 3D positions it is given;
it does not follow the ground. Options:

- `arc: 'geodesic'` bends it along great circles;
- `dash` draws dashes;
- `depthFailAlpha` draws a dimmer copy where the scene hides it.

Use lines for trails, orbits, launch paths, a ring at a fixed height, and
leader lines.

## Ground: fills on the ground

`engine.ground.createSet({ id, kind, order, pickable, drape })` makes a set
of flat fills that drape over the terrain and the 3D tiles. Nothing is
extruded.

Work with a set like this:

- `replace(items)` checks and stores all its items at once;
- `commit()` draws them in place of the last ones;
- `show(visible)` shows or hides the whole set;
- `list()` names the sets.

Positions are `[longitude, latitude]` in degrees, as GeoJSON stores them.
Edges follow great circles.

There are four kinds:

| kind       | item                                                    | for                                                       |
| ---------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `polygon`  | `rings: [outer, ...holes]`, `fill`, `outline`           | perimeters, airspace, footprints, cones, KML polygons     |
| `disc`     | `center`, `radiusM` (metres along the ground)           | earthquakes, air-quality stations, a pad zone             |
| `cell`     | `west`, `south`, `east`, `north` (meridians, parallels) | GNSS and FIRMS cells, privacy cells                       |
| `corridor` | `positions`, `color`, `widthPx` or `widthM`             | routes, cables, roads, coverage lines, outlines in metres |

Item options:

- Every item has its own colours, rgba in 0..1; the alpha is the opacity.
- `fill` and `outline` (`{ color, widthPx }`) are optional; an outline runs
  along every ring.
- Within a set, a later item draws on top. Between sets, a higher `order`
  draws on top. All ground fills draw under movers, lines and models.
- `pickable: true` makes picks return an item's `pickId`, with `owner` (the
  set) and `instance` (the item's index).
- `drape` is `'both'` (the default), `'terrain'` or `'tiles'`. Cesium
  honours it; Navara drapes on whatever surface it draws.

### How each engine draws the ground

**Cesium** (`src/globe/cesium/ground.js`) builds at most two batches per set:

- one `GroundPrimitive` for all the fills (polygons, ellipses, rectangles and
  metre corridors);
- one `GroundPolylinePrimitive` for all the outlines and pixel corridors.

Both use per-instance colours and the set's `classificationType`. Cesium
builds them in workers; the set's `ready()` turns true once they are drawn.
A set that is not pickable stays out of the pick pass, so it never hides
what lies under it.

**Navara** (`src/globe/navara/ground/`) draws every shown set in one screen
pass after tone mapping. Each pixel's ground position comes from the scene
depth (terrain and 3D tiles), and the pixel is tested against the items in
its screen cell:

- a disc against its radius;
- an area against its edges;
- a corridor against its distance to the line.

The tests run in each item's own gnomonic plane, so great-circle edges stay
straight. Fills and outlines are anti-aliased across one pixel and blended
in display space, in draw order, as Cesium blends them.

Large shapes get extra structure:

- An area with more than 32 edges gets a grid of bins. A pixel then tests
  only the edges of its own bin.
- A long corridor is split into chunks of 4 segments.
- The terrain heights under each item bound its screen box.

Picks are CPU picks at the ground under the pointer (`src/globe/ground.js`).

Navara's vector layers (`src/globe/navara/ground/vector.js`) were measured
as the other candidate and kept only as a prototype. The measurements are
below.

### Measurements

Setup:

- Dubai, 1280×800, keyless, daylight;
- headless Chrome on an Apple M2 Pro (ANGLE Metal);
- `scripts/qa-ground-bench.mjs`.

Frame times are medians, from preUpdate to a 1-pixel readPixels after
postRender. "Still" means the camera is at rest; "moving" means it turns
every frame. The empty scene takes about 6–9 ms in both cases. Memory is
measured after a GC, against the scene before the commit.

Small polygons (10 vertices, 100–400 m, eight colours, 1 px outline):

| N      | Cesium still / moving | Navara pass still / moving | Navara vector still / moving |
| ------ | --------------------- | -------------------------- | ---------------------------- |
| 10     | 4.9 / 5.0 ms          | 5.7 / 9.5 ms               | 5.7 / 24.5 ms                |
| 1 000  | 5.8 / 5.9 ms          | 6.2 / 10.9 ms              | 5.9 / 29.0 ms                |
| 10 000 | 12.0 / 11.2 ms        | 10.9 / 15.9 ms             | 5.7 / 29.0 ms                |

What each approach costs, apart from frame time:

| N      | Cesium                       | Navara pass               | Navara vector                    |
| ------ | ---------------------------- | ------------------------- | -------------------------------- |
| 10     | 0.2 s build, +0.2 MB WebGL   | 16 ms build, +0.04 MB GPU | 0.24 s build, about +70 MB WebGL |
| 1 000  | 0.23 s build, +19.5 MB WebGL | 68 ms build, +0.45 MB GPU | 0.23 s build, +144 MB WebGL      |
| 10 000 | 0.8 s build, +40 MB WebGL    | 0.26 s build, +4.0 MB GPU | 0.5 s build, +146 MB WebGL       |

The JS heap at 10 000 polygons: Cesium +47 MB, Navara pass +16 MB, Navara
vector +19 MB.

One polygon of N vertices across the view (2 px outline), still:

| N     | Cesium | Navara pass | Navara vector |
| ----- | ------ | ----------- | ------------- |
| 100   | 6.2 ms | 6.6 ms      | 5.3 ms        |
| 1 000 | 5.9 ms | 7.0 ms      | 5.3 ms        |
| 5 000 | 6.4 ms | 7.3 ms      | 6.3 ms        |

Without the bins, the pass took 46 ms at 1 000 vertices and 137 ms at 5 000.

Corridors (40-point lines, 2.5 px), still / moving:

| N      | Cesium         | Navara pass    | Navara vector |
| ------ | -------------- | -------------- | ------------- |
| 10     | 5.8 / 5.8 ms   | 5.7 / 9.7 ms   | 6.6 / 25.8 ms |
| 1 000  | 11.2 / 11.2 ms | 18.6 / 24.4 ms | 6.7 / 28.4 ms |
| 10 000 | 21.6 / 21.6 ms | 135 / 174 ms   | 6.3 / 28.0 ms |

At 10 000 corridors Cesium allocated 613 MB of WebGL memory, the pass 44 MB
and the vector layers about 70 MB.

Edge quality over the Hajar mountains, oblique view:

- **Cesium:** a sharp drape with its outline.
- **Navara pass:** the same.
- **Navara vector layers:** they are lit and tone-mapped like the scene, so
  a fill's colour is not the one asked for. They draw under Navara's clouds.
  A clamped polygon's outline is not drawn at all.

Show and hide (`scripts/qa-ground-switch.mjs`), before and after a Navara →
Cesium → Navara switch:

- **The pass:** correct every time.
- **Vector layers hidden by `layer.update({ show: false })`:** never hidden,
  before or after a switch.
- **Vector layers hidden by deleting them** (today's workaround in
  `navaraPolygons.js`): correct.

### Decision

**Navara draws every kind through the screen pass.** For polygons, discs and
cells it is as fast as Cesium up to 10 000 items. It holds a few megabytes
instead of a hundred or more. It draws exact colours and outlines, and its
show and hide are reliable.

The vector layers draw thin lines cheaply at rest. They cost about 20 ms
more on every frame the camera moves, whatever their count. They draw no
ground outlines and no metre widths. Their colours are lit, and hiding them
needs a rebuild.

Corridors are the pass's limit: about 1 000 lines draw at 18 ms, but 10 000
take 135 ms. A layer with more lines than that (Street Level's up to 14 400
sequences) needs a set-wide grid of bins first, as areas have, before it
moves to `engine.ground`.

### Choosing a primitive

- **A position and an on-screen size:** a mover.
- **A line at given heights, or one that moves or is restyled every frame**
  (trails, orbits, a ring at the terrain height): a line.
- **Anything that lies on the ground** and follows its relief:
  - an area: `polygon`, or `disc` or `cell` when that is its shape (they
    are exact and cheaper);
  - a line on the ground: `corridor`, with `widthM` when its width is a
    real width (an outline in metres) and `widthPx` otherwise.
- Group items that change together into one set, and replace them in bulk.
  A ground set is rebuilt on every commit, so an animated fill (a pulse, a
  flowing route) is not a ground set yet.

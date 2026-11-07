# Globe primitives

A layer draws through the globe-engine contract (`src/globe/contract.js`),
not through Cesium or Navara. The contract has four drawing primitives:

- `engine.movers`: things at points;
- `engine.lines`: lines in the air;
- `engine.ground`: fills on the ground;
- `engine.imagery`: rasters on the ground.

Each engine implements all four. Cesium's are in `src/globe/cesium/`,
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

A `widthPx` corridor can also take the looks Cesium's ground polyline
materials gave it. The GPU works them out every frame from the time, so a
commit never rebuilds them:

| look    | fields                                           | Cesium's                                                         |
| ------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `glow`  | `power`, `taper` (1: none)                       | `PolylineGlow`'s `glowPower` and `taperPower`                    |
| `pulse` | `periodMs`, `min`, `max`                         | the alpha times a factor from `min` to `max` and back, a sine    |
| `dash`  | `cells`, `duty`, `speed`, `gapAlpha`, `emission` | the annotation route's `GevRouteFlow`: dashes flowing to the end |

- `glow` brightens the line toward white along its centre and fades it to
  nothing at its edges.
- `pulse` follows the page's monotonic clock (`performance.now()`), as the
  old materials did, not the app clock.
- `dash` lays `cells` dashes along the whole line. Each is lit for its first
  `duty`, with soft edges of 0.08 of a cell, and brightened by `emission`
  times its colour. Between them the alpha is times `gapAlpha`. The dashes
  move toward the line's end at `speed` cells a second.
- A shown set with a `pulse` or a `dash` makes the engine draw a frame after
  every frame, as Cesium's continuous render did. `list()` reports it as
  `animated`. A `glow` alone does not animate.

Traffic's jam heat lines glow (power 0.25) and pulse (alpha 0.35 to 0.75,
1.63 s). The Directions route's 64 dashes flow at 0.55 cells a second.

### How each engine draws the ground

**Cesium** (`src/globe/cesium/ground.js`) builds at most two batches per set:

- one `GroundPrimitive` for all the fills (polygons, ellipses, rectangles and
  metre corridors);
- one `GroundPolylinePrimitive` for all the outlines and pixel corridors.

Both use per-instance colours and the set's `classificationType`. A
corridor with a look draws in a `GroundPolylinePrimitive` of its own look
and colour, over the set's other batches. Its material does the glow, pulse
and dash. The engine writes its time before every frame, and asks for the
next frame after every frame while the set is shown. Cesium
builds them in workers; the set's `ready()` turns true once they are drawn.
A set that is not pickable stays out of the pick pass, so it never hides
what lies under it.

**Navara** (`src/globe/navara/ground/`) draws every shown set in one screen
pass after tone mapping. Each pixel's ground position comes from the scene
depth (terrain and 3D tiles), and the pixel is tested against the items in
its screen cell:

- a disc against its radius;
- an area against its edges;
- a corridor tile against the corridor segments near the pixel.

The tests run in each item's own gnomonic plane, so great-circle edges stay
straight. Fills and outlines are anti-aliased across one pixel and blended
in display space, in draw order, as Cesium blends them.

Large shapes get extra structure:

- An area with more than 32 edges gets a grid of bins. A pixel then tests
  only the edges of its own bin.
- A corridor set becomes tiles, set-wide grids of bins
  (`src/globe/navara/ground/corridors.js`). See below.
- The terrain heights under each item bound its screen box.

**Corridor tiles.** A set's lines are cut into pieces of at most 0.5°
along their great circles. The pieces fall into a tree of longitude and
latitude tiles, each with at most 20 000 pieces and at most 20° a side. A
tile is one pass item:

- a gnomonic plane of its own;
- the pieces that come near it, as segments in that plane;
- a pyramid of square bins. A bin of level z is 2^z times the finest bin.
  It lists runs of segments, item by item in draw order: the segments that
  reach within its margin. The margin is half a bin for the set's thinnest
  corridor, more for a wider one, plus a width in metres.

The finest bin is sized so that it holds about two runs per piece. The
coarsest level has at most 8 bins across.

A pixel finds its ground in world space once. It takes the one tile of the
set whose cell holds it: the cells are tested with the meridians' normals
and the parallels' sines, so two neighbouring tiles never both draw a
pixel. The pixel then takes the finest level whose margin covers the
reach of the set's thinnest corridor, and tests only its bin's runs. Each
item takes its nearest segment there, and blends once, in item order. When
the pixel is wider than the coarsest margin covers (a tile under about 30
pixels), lines near a tile's edge can lose a little of a neighbour's
reach; the tile is a solid blur by then.

A commit packs the tiles once. Only the heights are sampled again when the
terrain loads later.

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

The pass with corridor tiles, measured again with the pass before them on
the same afternoon (the machine busier, the empty scene 6.0–8.9 ms):

| N      | Cesium         | pass before    | pass with tiles |
| ------ | -------------- | -------------- | --------------- |
| 1 000  | 12.8 / 13.9 ms | 19.8 / 24.9 ms | 9.1 / 12.6 ms   |
| 10 000 | 23.1 / 23.2 ms | 151 / 196 ms   | 12.1 / 15.4 ms  |
| 15 000 | 31.8 / 31.4 ms | 226 / 289 ms   | 17.7 / 19.7 ms  |

The tiles hold about what the chunks held: 47 MB of textures at 10 000
corridors (46 MB before), 68 MB at 15 000 (69 MB). Packing takes longer:
the commit of 10 000 corridors went from 0.6 s to about 1.9 s, and 15 000
from 0.8 s to 3.0 s.

A pixel corridor's width is now measured across the line (the gradient of
the distance to it), so it is the same at any angle, as on Cesium. Before,
a diagonal line drew up to √2 wider.

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

Corridors were the pass's limit: 10 000 lines took 135 ms. With a
set-wide grid of bins (corridor tiles), 10 000 take 12 ms, under Cesium's
23 ms.

## Imagery: rasters on the ground

`engine.imagery.createLayer({ id, source, alpha, show, split, order })`
makes one raster layer draped over the terrain and the 3D tiles, under
every ground fill, mover, line and model. Its colours are the image's own,
blended by the texel's alpha times the layer's `alpha`.

There are two kinds of source:

| kind    | source                                                                                                | for                                                      |
| ------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `tiles` | `url` with `{z}`, `{x}`, `{y}` (and `{s}` of `subdomains`), `minLevel`, `maxLevel`, `tileSize`        | Recent Imagery's GIBS days, weather tiles, open overlays |
| `image` | `image`: a canvas, an ImageBitmap or image element, or `{ width, height, data }` RGBA bytes; or `url` | the FIRMS heat raster, a field image, event imagery      |

Both take:

- `rectangle` (`{ west, south, east, north }` in degrees; west > east
  crosses the antimeridian): where the layer draws, the globe when omitted;
- `credit`: HTML shown while the layer is.

Tiles are Web Mercator XYZ tiles and stop at ±85.05°. `opaque` tiles have
no alpha channel, and `maxRequests` caps the layer's tile requests in
flight. An image is stretched over its rectangle in longitude and latitude,
row 0 on the north edge; one over the whole globe wraps across 180°.

Work with a layer like this:

- `setSource(source)` draws another source in its place, at its place in
  the order; the same canvas or bytes again draw their new pixels;
- `setAlpha(alpha)` fades it: at 0 it draws nothing but stays on its
  surface, so it comes back without a gap (the FIRMS hand-off);
- `show(visible)` shows or hides it (Cesium unmaps a hidden layer's tiles);
- `setSplit('left' | 'right' | 'none')` puts it on one side of the split;
- `ready()` says the source is built (an image URL loaded); tiles arrive
  after it;
- `destroy()`.

On the engine:

- `list()` names the layers in draw order, bottom first: a higher `order`
  draws on top, then the later layer;
- `setSplitPosition(fraction)` sets where the split runs, a fraction of the
  canvas width from the left (one per engine, Cesium's
  `scene.splitPosition`); `splitPosition()` reads it;
- `surface()` says where imagery drapes now: `'globe'`, `'tiles'` (3D tiles)
  or `'none'`.

### How each engine draws imagery

**Cesium** (`src/globe/cesium/imagery.js`) gives each layer one
`ImageryLayer`:

- on the globe's imagery layers while the globe shows, else on the shown 3D
  tileset's own imagery layers (Cesium drapes imagery on tiles there), as
  `src/maps/imageryHost.js` resolves it for the shell; with neither, the
  layers wait;
- the engine checks the surface on every frame while it holds a layer, and
  builds each layer again on the new stack after a switch;
- above the base imagery, in order among the engine's layers; imagery other
  code adds stays where it was put;
- tiles: a `UrlTemplateImageryProvider` in Web Mercator, bounded to the
  rectangle; `maxRequests` gates `requestImage`, and a request the gate or
  the provider defers asks for one delayed frame, never one per frame;
- an image: one geographic tile over the rectangle (as
  `SingleTileImageryProvider`), handed to Cesium as the canvas or image
  itself, with no PNG round trip;
- `split` is the layer's `splitDirection`; Cesium splits on the globe only.

**Navara** (`src/globe/navara/imagery/`) draws every shown layer in one
screen pass right after tone mapping, under the other drapes and
`engine.ground`:

- each pixel's ground position comes from the scene depth (terrain and 3D
  tiles), as `engine.ground`'s pass finds it;
- up to 8 layers are sampled in draw order at its longitude and latitude,
  each in its rectangle and on its side of the split (the top 8 when more
  are shown);
- an image is one mipmapped texture, sampled in longitude and latitude;
- tiles are an atlas of at most 8×8 Web Mercator tiles over the part of the
  rectangle in view, at the level the camera's height asks for; it is
  rebuilt when the camera moves to another plan and filled as tiles arrive,
  6 loads at a time (or `maxRequests`);
- texels are blended in display space, as Cesium's globe blends imagery;
  mip levels come from the derivatives of the ground position, taken
  before any branch, so rectangle edges and the antimeridian show no seams.

`engine.imagery` is the successor of `engine.maps.addOverlay`, Navara's
undocumented extension for the open map overlays (Sea Marks, Ski Pistes).
That one adds a native Navara raster layer: Navara's own per-tile levels on
the terrain, lit like the base map, but no rectangle, split, alpha or order,
and nothing on 3D tiles. It stays until those overlays move, which needs a
finer Navara tiles path first: a global overlay seen obliquely gets coarse
near the camera from one 8×8 atlas over the whole view.

### What is still to move

- **Weather radar, satellite clouds and lightning** (`src/layers/weather/`):
  tile templates in geographic and Web Mercator tilings, decoded canvases
  tiled into a provider, staged frames (a new frame loads under the shown
  one at alpha 0 and replaces it once its tiles are in), a per-tile image
  transform (the infrared mask), a detail window over the global image,
  and the raised shells Cesium draws over 3D tiles at a height. They need a
  geographic `tiles` scheme, a staged `setSource` (or `ready()` per tile
  set) and a tile transform; the raised shell is a separate primitive.
- **The wind field** (`src/layers/wind/`): one image over the globe at a
  fixed alpha, faded by camera height — an `image` layer — and the same
  raised shell on 3D tiles.
- **The Bhote Koshi event imagery** (`src/layers/bhoteKoshi/`, Cesium in
  `src/data/bhoteKoshiEvent.js`): two image URLs over one rectangle, split
  left and right, alpha 0.96 — two `image` layers with `url` and `split`.
  Navara still draws them with `src/layers/recentImagery/render/navaraGround.js`.

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
  A ground set is rebuilt on every commit, so a fill that changes over time
  is not a ground set, except a pixel corridor's glow, pulse and dash, which
  the engine animates.
- **Pixels on the ground** (tiles, a raster, a photo): an imagery layer.
  Fade it with `setAlpha`, and give a new raster to `setSource`.

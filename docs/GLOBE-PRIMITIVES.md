# Globe primitives

A layer draws through the globe-engine contract (`src/globe/contract.js`),
not through Cesium or Navara. The contract has five drawing primitives:

- `engine.movers`: things at points;
- `engine.lines`: lines in the air;
- `engine.ground`: fills on the ground;
- `engine.imagery`: rasters on the ground;
- `engine.meshes`: textured or coloured world triangles.

Each engine implements all five. Cesium's are in `src/globe/cesium/`,
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

Point instances may also set `outlineColor` independently of the fill,
so an expanding callout can fade its outline without changing its width.

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

A pixel corridor may instead use `dashPattern: { lengthPx, pattern: 255 }`,
a static 16-bit screen-space dash mask with transparent gaps, as Cesium's
PolylineDash material. It cannot combine with the other corridor looks.
Bhote Koshi uses an 18 px dash behind its 5 px glowing flood core.

Use `dynamic: true` on a set whose path changes each frame. Cesium waits
for its shared terrain-height bounds, then builds these small reveals
synchronously so successive frames do not discard unfinished worker jobs.
Other sets retain asynchronous building.

### Radial pulse fields

`engine.ground.createPulseField({ id, center, radiusM, heightM, color,
lineColor, haloColor, depth, lineWidth, haloWidth })` draws up to four
concentric pulse fronts. The centre is Earth-fixed metres; the radius is
metres along the surface. The disc lies on the ellipsoid raised by
`heightM` (default 0), with normal scene depth testing. Colours are rgba in
0..1, widths are CSS pixels, and `depth` is the inward band depth as a
fraction of the radius. A band's opacity falls quadratically to zero.

Call `draw({ radii, alphas, level })` with up to four radius fractions and
opacities in 0..1. Missing fronts are zero. `level` controls visibility;
the caller includes it in the alphas. The field starts hidden. `move(center)`
follows a new centre; `destroy()` releases it and is safe to repeat.
`ground.list()` includes it as `kind: 'pulse-field'`. The caller owns its
clock and render requests; the field starts no animation loop.

Global Context keeps its 2,500 m pulse height, fixed-width front and halo,
wake and rest windows, reduced-motion behaviour and 80 ms frame cadence.
Cesium retains one material disc, updating its uniforms and rotating for
small moves. Navara evaluates the same bands after tone mapping against a
raised ellipsoid and scene depth; its shader lives in
`src/globe/navara/ground/pulse.js`. The fake engine records the same state.

Bhote Koshi's event and locator share `src/layers/bhoteKoshi/render/story.js`:
the authored reveal properties feed ground corridors and polygons, and
point movers retain their independent fill and outline opacity. No story
backend is selected by engine. The authored model still uses its existing
property records; removing that model dependency is separate work.

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
the same day (the machine busier, the empty scene 6.7–8.1 ms):

| N      | Cesium         | pass before    | pass with tiles |
| ------ | -------------- | -------------- | --------------- |
| 1 000  | 12.8 / 13.9 ms | 19.8 / 24.9 ms | 8.7 / 10.0 ms   |
| 10 000 | 23.1 / 23.2 ms | 151 / 196 ms   | 11.8 / 13.8 ms  |
| 15 000 | 31.8 / 31.4 ms | 226 / 289 ms   | 17.9 / 19.9 ms  |

The tiles hold about what the chunks held: 43 MB of textures at 10 000
corridors (46 MB before), 66 MB at 15 000 (69 MB). Packing takes longer:
the commit of 10 000 corridors went from 0.6 s to 1.1 s, and 15 000 from
0.8 s to 1.7 s.

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
set-wide grid of bins (corridor tiles), 10 000 take 12 ms still and 14 ms
moving, under Cesium's 23 ms.

## Imagery: rasters on the ground

`engine.imagery.createLayer({ id, source, alpha, show, split, order, raise })`
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

Tiles are Web Mercator XYZ tiles, which stop at ±85.05°, or with
`scheme: 'geographic'` EPSG:4326 tiles (2×1 at level 0, y down from 90°N,
Cesium's `GeographicTilingScheme`). `opaque` tiles have no alpha channel,
and `maxRequests` caps the layer's tile requests in flight.
`transform(image)` turns each decoded tile (row 0 on the north edge) into
the canvas or image that draws: the weather's infrared mask. An image is
stretched over its rectangle in longitude and latitude, row 0 on the north
edge; one over the whole globe wraps across 180°.

`raise: heightM` puts an image layer on a shell that high above the
ellipsoid instead of draping it: it draws over terrain, 3D tiles and the
sky's edge, hidden only by what is nearer. The shell rises with the camera
(4 m per kilometre of camera height, at most 60 km, in 500 m steps) so the
coarse 3D tiles seen from far never hide it. Raised layers take image
sources only.

Work with a layer like this:

- `setSource(source)` draws another source in its place, at its place in
  the order; the same canvas or bytes again draw their new pixels, and a
  source that differs only in its `credit` keeps its pixels;
- `setSource(source, { staged: true, signal })` keeps the drawn source
  until the new one is complete (the image loaded; the tiles in view in),
  then swaps them. It resolves true then, and false when the new source
  failed, `signal` aborted it, or another `setSource` replaced it first. A
  hidden layer takes it at once. `staging()` says one is on its way;
- `setDetail({ image, rectangle } | null)` (raised layers): inside the
  rectangle the layer draws the detail image in place of its own (a
  sharper view of the area in view). The last detail draws until the new
  one is uploaded; it resolves true once it draws. null clears it;
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
- geographic tiles: a `GeographicTilingScheme`; a transform wraps
  `requestImage` (Cesium's tile bitmaps arrive flipped, so the transform
  gets them upright on a canvas);
- a credit is read through the provider's `credit` getter every frame, so a
  new credit of the same source needs no new layer;
- a staged source is a second `ImageryLayer` at alpha 0 right over the
  drawn one, whose tiles Cesium loads while the drawn one shows. Its own
  requests are counted (deferrals too); once they are in (the globe's tiles
  all loaded, or its own requests quiet for 200 ms) for two frames in a
  row, it takes the drawn one's alpha and the drawn one goes after the next
  frame. Throttled tiles (429, 503) retry three times; any other failed
  tile fails the source;
- a raised layer is a primitive of its own (`imageryShell.js`): a
  rectangle at the height with a material of the image and the detail in
  its window, flat, alpha blended in the opaque pass without depth writes,
  first in `scene.primitives` in the imagery order, lifted by a uniform
  scale about the Earth's centre. A new image on the same rectangle swaps
  once uploaded; another rectangle is a new shell at alpha 0 until drawn;
- `split` is the layer's `splitDirection`; Cesium splits on the globe only
  (not raised layers).

**Navara** (`src/globe/navara/imagery/`) draws every shown layer in one
screen pass right after tone mapping, under the other drapes and
`engine.ground`:

- each pixel's ground position comes from the scene depth (terrain and 3D
  tiles), as `engine.ground`'s pass finds it;
- up to 8 layers are sampled in draw order at its longitude and latitude,
  each in its rectangle and on its side of the split (the top 8 when more
  are shown);
- an image is one mipmapped texture, sampled in longitude and latitude;
- tiles are an atlas of at most 8×8 Web Mercator or geographic tiles over
  the part of the rectangle in view, at the level the camera's height asks
  for (a geographic level one below Web Mercator's); it is rebuilt when the
  camera moves to another plan and filled as tiles arrive, each through the
  transform, 6 loads at a time (or `maxRequests`);
- a staged source builds its own texture or atlas (for the view now, again
  when the camera moves) while the drawn one shows, and takes its place
  once every tile of it has settled; a failed tile fails it;
- a raised slot is sampled where the pixel's ray meets the ellipsoid grown
  by its lifted height, where nothing of the scene is nearer; a detail is a
  second slot right over its layer's, which draws nothing inside the
  detail's rectangle;
- texels are blended in display space, as Cesium's globe blends imagery;
  mip levels come from the derivatives of the ground position, taken
  before any branch, so rectangle edges and the antimeridian show no seams.

Open map overlays (Sea Marks, Ski Pistes) use `engine.imagery` when the
engine has no `maps.addOverlay`. Navara keeps that optional native raster
path for its per-tile detail. It adds a native Navara raster layer: Navara's own per-tile levels on
the terrain, lit like the base map, but no rectangle, split, alpha or order,
and nothing on 3D tiles. Moving that path to imagery needs finer Navara tile detail: a global overlay seen obliquely gets coarse
near the camera from one 8×8 atlas over the whole view.

### Who draws through imagery

- **FIRMS heat** (`src/layers/firms/render/display.js`): one image.
- **Recent Imagery** (`src/layers/recentImagery/render/display.js`): two
  Web Mercator tile layers under a split.
- **Weather radar, satellite clouds and lightning**
  (`src/layers/weather/render/display.js`): on the globe, the product's
  geographic tiles (the regional infrared through its mask, a tile
  transform), or the global infrared mosaic as one image; each new frame a
  staged source; clouds, radar and lightning at orders 21, 22, 23. On 3D
  tiles, a raised layer at the product's shell height
  (`shellRendering.js` `WEATHER_SHELL_HEIGHTS`) with the detail window
  around the view as its detail.
- **The wind field** (`src/layers/wind/render/display.js`): one image over
  the globe at order 20, faded with the camera's height while streamlines
  draw, raised at 5 km on 3D tiles. The streamlines stay each engine's,
  behind the display's `flow` backend, loaded by the manifest:
  `src/globe/cesium/windFlow.js` supplies Cesium's streamlines
  (`src/layers/wind/rendering.js`), and `src/globe/navara/windFlow.js`
  supplies Navara's flow mesh.
- **The Bhote Koshi event imagery** (`src/layers/bhoteKoshi/render/display.js`):
  two `url` images over the event's rectangle at alpha 0.96, split left
  and right at the engine's split position, order 15. The event's and the
  locator's story graphics use the shared ground and mover display described
  above.

- **Imported KML/KMZ ground images** (`src/data/geoImportDisplay.js`): one
  image layer per rectangle at order 30, with the authored alpha capped at
  0.99 as on Cesium.
- **Sea Marks and Ski Pistes** (`src/data/osmOverlays.js`): tile layers at
  order 10 on engines without `maps.addOverlay`.

## Imported files

`geoFileImport.js` reads GeoJSON, GPX, KML and KMZ into the plain records in
`src/data/geoImportRecords.js`. `geoImportKml.js` resolves KML styles with
Cesium's precedence; its tests compare the records with `KmlDataSource`.
No import loads the Cesium SDK. One `geoImportDisplay.js` draws the records
on every engine: points on movers, ground paths and polygon fills on ground,
raised paths and outlines on lines, and packed ground images on imagery.
Every owned id starts with `geo-import-`; the file controller owns visibility,
framing, refresh and destruction across engine switches.

Pins use composed square sprites to retain Cesium's pin tip, hot spot,
subregion, colour, scale and rotation. Ground heights come from the loaded
surface, refreshed after the camera or map settles. Ground pins ignore scene
depth and are culled beyond the horizon; absolute pins retain their height.

The shared display has known limits against Cesium: wall fills and extruded
prisms are omitted (their top geometry remains), and `gx:LatLonQuad` is
omitted. These are counted as undrawn. Raised polygon fills drape; their
outlines retain altitude. Ground-overlay rotation, altitude and RGB tint are
not applied, and ground edges use great circles rather than rhumb lines.
These appearance limits are not included in the undrawn count.

## Input ownership

`engine.input.suspendCameraInputs()` disables camera gestures and returns an
idempotent resume function. Suspensions are counted: only the last resume
restores the state captured before the first suspension. This preserves an
already-disabled camera. A `setCameraInputs()` call during suspension updates
the state restored on resume. `cameraInputsEnabled()` reads the current state.
Cockpit, imagery-box drawing, CCTV calibration and infrastructure flights use
these methods on every engine. Pointer claims remain separate from camera
input suspension.

Pick ownership belongs to the scene attachment, not to an engine implementation.
`scene.services.picking` owns its predicates and `scene.services.selection` owns
its shared click dispatcher. Layer entry points resolve these services using
their attached engine (`sceneServicesFor(engine)`); the pick-registry helper
functions take that engine as their final argument. Standalone entries acquire
the same services on first use. The application destroys them on detach and
creates fresh services when reattaching a parked engine. Identical layer IDs in
simultaneous scenes cannot replace or unregister one another's picks.

## Render demand

`scene.services.render` owns continuous-render holds and the last 16 idle
request reasons for one attachment. `holdContinuousRender(id)` and
`releaseContinuousRender(id)` are idempotent per owner; the last release
requests one settling frame. `governorRequestRender(reason)` forwards a
one-shot request even while another owner holds continuous rendering.
The tools call `install()` after scene consumers have registered their holds.

The governor drives `engine.render` on every engine. Cesium implements
`setContinuous` with its scene's `requestRenderMode` and disables automatic
simulation-time renders with `maximumRenderTimeChange = Infinity`. Engine
internals request their own scene directly and never import the governor.
Layer service helpers take their attached engine as the final argument;
attachment-bound callbacks can capture `renderGovernorFor(engine)` directly.
Destroying the scene clears its holds and makes the captured service inert.
A parked engine gets a fresh service when reattached.

## Render effects

The optional `visualStyles`, `bloom` and `contactSonar` capabilities are
available on Cesium and Navara through `engine.render`. Cesium implements
styles, sharpening, borrowed bloom and the Anime Milky Way fade in
`src/globe/cesium/postStages.js`; contact sonar is in `sonar.js` and
`sonarCommands.js`. Cesium does not advertise `cloudCover`.

`VisualEffects` drives transitions through the render contract. UI teardown
stops animation and disables effects; engine destruction removes its stages
and restores the borrowed bloom state. Sharpen intensity zero disables
sharpening on both engines, following Cesium.

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
  A ground set rebuilds on commit. Small paths revealed each frame use
  `dynamic: true`; corridor looks animate without a rebuild, and radial
  fronts use `ground.createPulseField`.
- **Pixels on the ground** (tiles, a raster, a photo): an imagery layer.
  Fade it with `setAlpha`, and give a new raster to `setSource`.

## Meshes: world triangles

`engine.meshes.createMesh({ id, positions, indices, uv, image, color, show,
depthTest, pickId })` draws indexed triangles on both sides. Positions are
flat Earth-fixed xyz metres and indices name their vertices. Optional UVs run
from (0, 0) at the image's bottom left to (1, 1) at its top right. The engine
copies geometry arrays; the caller owns the canvas, image or video.

`update(patch)` replaces only supplied fields. Repeating `image` uploads new
canvas pixels; videos update on rendered frames. RGBA `color` multiplies the
image, white by default. `show()` reads visibility and `show(boolean)` changes
it. `depthTest` is `normal` or `always`; null `pickId` disables picking. Picks
return the authored id and the mesh id as owner. `destroy()` is idempotent;
`engine.meshes.list()` returns live ids in creation order.

Cesium draws a synchronous Primitive with a flat material, no back-face
culling and no depth writes. Colour, image and visibility changes retain the
primitive; geometry, pick-id and depth-test changes replace it. The engine
requests frames while the primitive or its image is preparing. Navara draws
local coordinates relative to a double-precision world origin in its
transparent scene pass after tone mapping, with scene depth and triangle
picking. Their authored colours are blended in display space.
Both engines own geometry, material and texture disposal. The fake engine
keeps the same state and tests triangle intersections for picks.

CCTV's `render/meshes.js` describes its live monitor quad and viewshed pyramid
through this primitive. Its markers and outlines remain movers and lines.
Obstruction probes use `engine.surface.raycast`; exclusions accept owned mesh,
line and mover handles on Cesium and restore their visibility after the query.

Data packs use one `src/scenes/dataPacks/display.js`: points on movers,
straight raised paths on lines, raised polygons and image rectangles on
meshes, and media markers with captions in a composed sprite. Polygon holes
and authored vertex heights are retained. Shared triangulation uses `earcut`,
with tests comparing its area to Cesium's polygon geometry. Images retain
Cesium's one-degree rectangle grid. Scene detach releases drawn resources and
pick targets; reattach redraws the retained decoded assets.

Annotation drapes still use their existing renderers. Their bounded building
classification volumes, animated fills and wire cages are not ordinary world
triangles; they need a classification contract before that migration can
preserve Cesium's behaviour.

## Shared follow offsets and manual drawing

`engine.camera.follow({ position, viewFrom, swingTo })` can swing from the
initial follow frame to `swingTo`, an east/north/up offset in metres. Each
frame turns at most 60 degrees and interpolates range, preserving Cesium's
tracked-camera crossing guard. `handle.retarget({ swingTo })` changes only
the pending swing; `null` cancels it. Stopping or replacing the follow, a
camera command or engine destruction ends it. Share links read the current
handle's target and label identity and the camera pose through the contract.

`engine.input.acquirePointer()` returns an exclusive claim, or `null` if
one is held. Pass it to `input.on(type, listener, { pointer: claim })` and
call `claim.release()` when done. Other screen subscriptions yield, including
picks that settle after ownership changes. Camera gestures stay enabled.
Cesium suspends its stock select and track clicks and restores the original
functions when the claim is released or the engine is destroyed.

The Draw tool uses one `drawSurface.js` on every engine: a dashed geodesic
line and a point mover set at the clicked heights. The dim, occluded band
uses the selected colour as well as the visible band. Finished geometry still
goes through the annotation board. Detaching the scene releases the claim,
listeners and preview while retaining the chosen shape and colour. The
page's pointer lease still arbitrates Draw against other tools.

## How to add an engine

Put the implementation in a new `src/globe/<name>/` folder. Keep SDK classes,
shaders, resource disposal and SDK workarounds there. Use
`src/globe/testing/fakeEngine.js` as the contract model, and
`src/globe/contract.js` as the authoritative member and data-shape reference.
Coordinates, colours, picks and display options crossing the boundary are plain
data; displays do not receive native viewers or SDK types.

Implement the required host, camera, picker, projector, frame, render, surface,
input, credit, clock and map interfaces, plus all five drawing primitives:
`movers`, `lines`, `ground`, `imagery` and `meshes`. `engineCapabilities(engine)`
reports these and the optional visualStyles, bloom, cloudCover and contactSonar
groups. An optional group must be complete or absent. Do not advertise a
capability with a no-op implementation. Match Cesium's behavior where the
contract permits both engines to implement it.

Run `createContractSuite(engine, { waitFrames, ... })` from
`src/globe/testing/contractSuite.mjs`. Supply real pointer delivery, canvases and
pixel reads for browser checks; keep the fake-engine tests as fast contract
checks. Test ownership and repeated destruction as well as visible output.
The browser harness is `scripts/qa-contract-suite.mjs`; ground and imagery pixel
checks also run through `scripts/qa-ground-suite.mjs`.

The application currently registers two kinds: adding another still requires
registration in `ENGINE_KINDS`, scene construction/choice and the corresponding
QA harnesses. `assertGlobeEngine` currently validates that registration. The
folder and passing contract suite are the implementation boundary, not a claim
that arbitrary engine folders are auto-discovered today. Layers and their
fixtures should need no new drawing implementation.

The layer manifest (`src/app/layers/renderers.js`) loads shared displays and
lists their `needs`. Today every valid engine must implement all five
primitives; availability is checked against the registered kind's primitive
list. `backends` supplies optional engine-specific display options, currently
only wind's `flow`. Load a backend dynamically from its engine folder. A new
engine can omit wind streamlines and still draw the shared raster field. Do not
copy another engine's extensions into a new engine. The self-drawing map overlay
entries currently list supported kinds explicitly and need registration too.

Run `src/app/layers/displayRehearsal.test.mjs`: it loads every manifest display
on the fake engine with an unknown kind and empty extensions. Its small fixtures
exercise attachment, drawing, hiding or release, and destruction; primitive
registries, frame/camera/input subscriptions, follow state and service records
must be clean before the engine itself is destroyed. New display entries need a
fixture. Wildlife Sightings and the two map overlays are explicit skips because
they have no display factory; their layer tests remain the coverage for those
controllers. Native wind streamlines, DOM rasterization and GPU pixels are not
covered by this rehearsal.

`node scripts/check-import-directions.mjs` enforces SDK ownership for static
imports, re-exports and literal dynamic imports, including package subpaths.
Cesium packages belong in `src/globe/cesium/`; three, postprocessing and Navara
packages belong in `src/globe/navara/`. Add the new SDK's ownership rule when
registering it. Contract graphs cannot reach any engine, and the existing
engines cannot reach one another. The temporary exact file/package exceptions
in `scripts/package-boundaries.json` must have reasons and must still be used;
the checker prints them. They are migration debt, not a pattern for new layers.
Run package boundaries, formatting, the full unit suite and the coupling report
as well; engine coupling counts may not grow.

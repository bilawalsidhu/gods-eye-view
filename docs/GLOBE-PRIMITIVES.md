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
`pickable`. `ready(index?)` says whether a model's glTF or a sprite atlas has
loaded and `failed(index?)` whether it failed to: a failed set is not loaded
again, so a layer that retries makes a new set. Cesium loads a model per
instance: an index written with another `pickId` loads its own model, so an
instance moved into a failed index does not inherit the failure.

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
- `drape` is `'both'` (the default), `'terrain'` or `'tiles'`. Both engines
  honour it: Navara tells 3D tiles from terrain by its globe depth, and its
  CPU picks skip a set draped only on the surface not shown (terrain while
  photoreal tiles show, tiles otherwise).

Discs with a fill may use `radial: { fillAlpha, rimAlpha, rimStart, rimEnd,
emission }`. Alpha multipliers are in 0..1; the radius fractions satisfy
`0 <= rimStart < rimEnd < 1`; emission is nonnegative. The rim grows with
smoothstep between the two radii, then fades smoothly to zero at the outer
edge. Space Missions uses a 500 m disc with alpha 0.105 inside and 0.72 at
the rim, transitions at 0.952 and 0.985, and emission 0.35. Cesium retains
its textured ground material and polygon depth bias. Navara composes the
same radial envelope in its ground pass after tone mapping.

An unpickable pixel corridor set with `reveal: true` accepts
`setReveal(fraction)` in 0..1. Each path is clipped at that fraction of its
length. Geometry stays intact: Cesium updates material uniforms and Navara
updates the corridor item texture. Hiding, showing and committing a new
path retain the fraction. A corridor may have `backing: { widthPx, color }`:
a wider edge with its own colour, with the core blended only once.

Transit drapes its history and active head through ground corridors. Its
completed runs retain their age bands, 5 px dark backing and 3 px colour,
with band updates once per displayed second. The active head is one backed
corridor revealed along the whole current segment; only a segment crossing
rebuilds its geometry. Transit uses dynamic sets so new history and head
corridors build synchronously once Cesium's terrain bounds are available.
The ground pass handles occlusion on both engines.

Cesium also builds reveal sets synchronously after loading those bounds.
For nonempty sets, `ready()` includes the visible globe's tile readiness:
classification needs the current surface depth as well as built geometry.

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

### Ground drawing guarantees

Both engines preserve item order, fill and outline colours, pixel and metre
widths, visibility, and pick ownership. Non-pickable sets let picks through.
`ready()` reports when committed geometry is ready to draw. Animated corridor
looks use the shared ground time and request frames while shown.

Cesium translates ground items to classified fills and polylines. Navara
classifies visible scene depth and blends the ground in display space.
Navara picks ground items at the surface under the pointer. Packing, tiling
and bin sizes are implementation details in `src/globe/navara/ground/`.

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

### Imagery drawing guarantees

Both engines draw imagery below ground shapes, movers, lines and models,
in layer order. Each texel blends by its alpha times the layer alpha.
Visibility, split position, rectangle bounds and raised-shell height follow
the imagery contract. Replacing or destroying a source releases its owned
resources; stale loads cannot replace the current source.

Cesium translates sources to imagery providers and raised shells. Navara
samples imagery in its surface pass, including raised ellipsoid intersections.
The adapters own texture storage, tile selection and depth reconstruction.

Cesium moves draped layers between the visible globe and tileset surfaces;
without either surface, layers wait. Its split applies to globe imagery,
not raised shells. Navara draws the top eight visible imagery slots, with
detail images consuming a slot. Staged sources keep the current image visible
until their replacement is ready; a failed source leaves it intact.

Open map overlays use `engine.imagery` when `maps.addOverlay` is absent.
Navara's optional native raster path retains terrain detail, but does not
provide rectangle bounds, split, alpha, order, or drawing on 3D tiles.

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
  0.99 as on Cesium; a tinted or rotated image is drawn on a canvas first,
  and an absolute one is raised to its altitude.
- **Sea Marks and Ski Pistes** (`src/data/osmOverlays.js`): tile layers at
  order 10 on engines without `maps.addOverlay`.

## Imported files

`geoFileImport.js` reads GeoJSON, GPX, KML and KMZ into the plain records in
`src/data/geoImportRecords.js`. `geoImportKml.js` resolves KML styles with
Cesium's precedence; its tests compare the records with `KmlDataSource`.
No import loads the Cesium SDK. One `geoImportDisplay.js` draws the records
on every engine: points on movers, ground paths and polygon fills on ground,
raised paths and outlines on lines, raised polygon fills on meshes, and packed
ground images on imagery.
Every owned id starts with `geo-import-`; the file controller owns visibility,
framing, refresh and destruction across engine switches.

Pins use composed square sprites to retain Cesium's pin tip, hot spot,
subregion, colour, scale and rotation; a KML heading turns with the camera's
heading, so it stays measured from north. Icon textures share a per-file
budget of 16 million pixels: many distinct styles get lower-resolution
textures at the same size. Ground heights come from the loaded surface,
refreshed after the camera or map settles, in batches of 256; on 3D tiles
only pins in the window are clamped to the tiles drawn. Ground pins ignore
scene depth and are culled beyond the horizon; absolute pins retain their
height.

Raised polygons (KML absolute or relative) draw their fills as meshes and
their outlines as lines at the vertices' heights. A ground overlay's colour
tints its image and its alpha fades it; a rotated overlay's image is turned
on a canvas over the box around it, as Cesium turns its rectangle in degrees,
and an absolute image or plain-colour overlay is a mesh at its altitude,
including negative heights (Cesium raises only absolute ones).
The shared display has known limits against Cesium: wall fills and extruded
prisms are omitted (their top geometry remains), and
`gx:LatLonQuad` and a rotated overlay whose box passes a pole are omitted.
These are counted as undrawn. Ground edges use great circles rather than
rhumb lines.

## Input ownership

`engine.input.on(type, listener, { pick, drill, pickWindow })` accepts
`pickWindow: { width, height }` with positive integer dimensions passed to
the picker. Omitted dimensions keep the engine default. Listeners share a
pick only when their windows match, and each receives its requested drill
limit. Pointer-down picks are synchronous. Moves, including drills, coalesce
to the latest position per frame. Navara clicks still use one GPU answer
from the gesture; a missing hit falls back to the requested CPU window.
Street Level requests 9 × 9 px; CCTV's gizmo requests its own window and
limit for presses and hover. Pointer ownership and removal still suppress
delivery while a pick is pending.

`engine.projector.horizonVisible(position, { ellipsoid })` accepts a plain
ellipsoid with positive finite `radii: { x, y, z }` in metres. Without the
option it uses WGS84. Street Level supplies WGS84 radii reduced by 1,000 m
so nearby cones remain visible below sea level. The shared math is tested
against the native ellipsoidal occluder, including points near the limb.

`engine.input.suspendCameraInputs()` disables camera gestures and returns an
idempotent resume function. Suspensions are counted: only the last resume
restores the state captured before the first suspension. This preserves an
already-disabled camera. `cameraInputsEnabled()` reads the current state.
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

## World overlays

`scene.services.overlay` owns one attachment's world labels and cards. It
keeps its sources, collision domains, paint lanes, canvases, frame listeners,
observers, timers and accessible action subscribers. `init()` installs its
DOM inside `engine.host.container`; the detection blend surface stays beside
the card root so it can blend against the scene.

Publish with `setEntries(sourceId, entries, options)`, `setVisible(sourceId,
visible)` and `clearSource(sourceId)`. Read painted rectangles with
`getPaintRect(sourceId, entryId)` and register custom painters with
`registerPaintLane(laneId, painter, options)`. `subscribeActions(listener)`
provides the accessible mirror; `activateAction(owner, key)` rejects an old
host's actions. The shell reconnects these operations on every attachment.

`worldOverlayFor(engine)` resolves the same service for standalone consumers.
The module helper functions take the engine first. Retained layer models use
`bindOverlayHost` with their attached-engine getter; injected hosts without a
`forEngine` resolver keep their own operations. Publications can buffer before
`init()`. Destruction is terminal, including before initialization; a parked
engine needs fresh scene services. An old paint-lane handle cannot mutate its
replacement. Font measurements are shared until the last live host releases
them.

`scene.services.trackedReadout` bridges the follow handle's label and selected
ALPR or Local ADS-B card into this overlay. `init()` subscribes to that engine's
follow changes and that attachment's context events; `refresh(entity)` republishes
changed label text, and `activeId()` resolves the card for annotation placement.
Positions stay live cached visual anchors. `trackedReadoutFor(engine)` resolves
the service; destruction removes its listeners and clears only its own source.

`scene.services.context` owns selection records and notifications. Layer publishers
use `bindOverlayHost` with their current engine, or a context service captured by
their display. It mirrors records to the page context slot and preserves the
`gev:entity-selected`, `gev:entity-selection-cleared` and aircraft awareness event
payloads for page consumers. A clear reaches the page only when that attachment
owns the page's selected record. Readouts listen only to their scene's event target.
Identical IDs in different scenes cannot share a card or clear one another's
selection. Retired context services cannot publish into a replacement attachment.
An engine handoff carries the page-selected record through the layer session.
The incoming context adopts it only while the page still selects that record;
a clear between attachments wins. Rebuilt markers replace the retained carrier
in the incoming readout without announcing another page selection.
Readout initialization reads the retained record without testing the outgoing
carrier's visibility; layers rebuild their carriers after camera restoration.
The page chrome and detection controller still have page lifetimes.

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

## Wildlife privacy cells

Wildlife privacy cells use one `cell` ground set for distinct bounds and taxon
accents. The fill is 25% opaque and the 2 px outline is 80% opaque, matching
Cesium's original ground geometry. Both drape on terrain and tiles and pass
picks through to the badges. Wide views and detach release the set.

## Batched line segments

`engine.lines.createSegments({ id, widthPx, color, order })` groups independent
straight segments in one batch. `replace(items)` copies pairs of Earth-fixed
endpoints and optional per-item `widthPx`, `color` and `pickId`; `commit()`
rebuilds the drawing once. Segments never connect to one another. `show()`
and `destroy()` affect the whole batch; an empty replacement clears it.
The batch shares `createLine`'s id namespace and `list()`, which includes its
endpoint count and committed `pickIds` in item order.

Cesium draws one synchronous primitive with per-instance colours and widths.
Navara draws one ribbon mesh in the overlay after tone mapping, with scene
depth and independent segment picks. Batches are solid and depth-tested;
curved, dashed, transformed and depth-fail lines still use `createLine`.
Infrastructure and cable references each use one batch for their visible
stems, preserving Cesium's colours, widths, label winners and update cadence.
Infrastructure excludes the whole stem batch while sampling its bases.

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
`movers`, `lines`, `ground`, `imagery` and `meshes`. `assertGlobeEngine(engine)`
checks these required interfaces. `engineCapabilities(engine)` reports only the
optional visualStyles, bloom, cloudCover and contactSonar groups. An optional
group must be complete or absent. Do not advertise a capability with a no-op implementation. Match Cesium's behavior where the
contract permits both engines to implement it.

Run `createContractSuite(engine, { waitFrames, ... })` from
`src/globe/testing/contractSuite.mjs`. Supply real pointer delivery, canvases and
pixel reads for browser checks; keep the fake-engine tests as fast contract
checks. Test ownership and repeated destruction as well as visible output.
The browser harness is `scripts/qa-contract-suite.mjs`; use
`--only=ground:,imagery:` for ground and imagery pixel checks.

Three reports keep migration debt from growing: `scripts/report-engine-coupling.mjs`
counts application coupling, `scripts/report-qa-harness.mjs` counts browser QA
duplication, and `src/globe/testing/contractCoverage.test.mjs` reports contract
members the fake-engine suite leaves uncalled. After removing coupling or moving
QA work to `scripts/qa-strict-harness.mjs` helpers, run the matching report with
`--write-baseline` and keep only decreases in its baseline. After adding behavioral
contract checks, remove the newly exercised names from
`src/globe/testing/contract-uncalled-baseline.json`; keep it sorted, and remove
members that no longer exist too. Run the matching tests with
`node --import=./build/registerVue.js --test` followed by their paths; the numeric
baselines reject growth, and the contract baseline also rejects stale entries.

The application currently registers two kinds: adding another still requires
registration in `ENGINE_KINDS`, scene construction/choice and the corresponding
QA harnesses. `assertGlobeEngine` currently validates that registration. The
folder and passing contract suite are the implementation boundary, not a claim
that arbitrary engine folders are auto-discovered today. Layers and their
fixtures should need no new drawing implementation.

The layer manifest (`src/app/layers/renderers.js`) loads shared factories through
`display`. Every valid engine implements all five primitives; the manifest has
no per-kind primitive lists or `needs` declarations. `backends` supplies optional
engine-specific display options, currently only wind's `flow`, loaded dynamically
from its engine folder. A missing wind backend leaves the shared raster field
available. Self-drawing layers and map overlays use the same contract and do not
register supported engine kinds in the manifest.

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

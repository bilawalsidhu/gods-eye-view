# Renderer contract

The renderer contract is what the application asks of a 3D renderer. The
Cesium renderer draws the application through it, and the stub renderer
stands in for it in tests. The contract is version `0`. Today the application
still drives Cesium directly; later work moves the layers onto the contract
one family at a time.

The package exports these modules:

| Export                               | What it is                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `gods-eye-view/render/contract`      | The types, one `.d.ts` per port, plus the run-time member list and shape check         |
| `gods-eye-view/render/stub`          | A renderer that draws nothing, for tests                                               |
| `gods-eye-view/render/camera/events` | The camera port's events: `changed` per listener, `moveStart`/`moveEnd`, command hooks |
| `gods-eye-view/render/conformance`   | The conformance suite, reference scenes and visual comparison                          |

The pieces that do not depend on Cesium are exported too, each with its
own `.d.ts`:

- `gods-eye-view/render/input/router`: the input port's leases and routing;
- `gods-eye-view/render/stub/camera`, `.../stub/viewRectangle` and
  `.../stub/harness`: the stub's camera, its view rectangle and its
  conformance harness;
- `gods-eye-view/render/motion`: where a moving icon is drawn at a time;
- `gods-eye-view/render/vectorBase`: the vector base painter;
- `gods-eye-view/render/iconSegment`: icon motion segments;
- `gods-eye-view/render/recession`: how a set that recedes shrinks and
  fades its items toward the limb;
- `gods-eye-view/render/windStreamlines`: the wind field's streamlines;
- `gods-eye-view/geo/screenCluster`: screen-space clustering.

`src/render/neutralExports.test.mjs` checks that each is declared, that its
names match what it exports, that it type-checks under strict TypeScript and
that it imports no Cesium.

A camera controller takes the camera events from `render/camera/events`
and the geodesy it needs (`geodesicAt`, `horizonFrom` and the rest) from
`gods-eye-view/geo`, so it measures and fires exactly as the stub does. `CameraControllerFactory`
(`camera.d.ts`) types such a controller: what it is given (`NativeCamera`)
and what it gives back (the camera port and its two frame steps).

## Ports

A renderer is created by a `RendererPlugin` (`{ id, create(options) }`). It
exposes nine ports, each typed in its own file in `src/render/contract/`:

| Port      | File           | Covers                                                                  |
| --------- | -------------- | ----------------------------------------------------------------------- |
| `frame`   | `frame.d.ts`   | The render-on-demand loop, frame phases, continuous holds, scene time   |
| `globe`   | `globe.d.ts`   | Base (photoreal, terrain, vector, imagery), imagery layers, split, sky  |
| `draw`    | `draw.d.ts`    | Draw sets: icons, points, lines, shapes, models, quads, meshes, fields  |
| `camera`  | `camera.d.ts`  | Pose, views, flights, `lookAt`, follow, user controls, events, matrices |
| `query`   | `query.d.ts`   | Picks, projection, rays, heights                                        |
| `input`   | `input.d.ts`   | Pointer events with their pick made, leases, stock behaviours           |
| `effects` | `effects.d.ts` | Screen styles, bloom, sharpen, screen modulation                        |
| `credits` | `credits.d.ts` | Data credits owed                                                       |
| `quality` | `quality.d.ts` | Quality knobs, device facts, frame signals                              |

Version `0` is still being shaped, and not only by additions. Members
were removed or replaced (among them `camera.move`, `look`,
`rotateAround` and `zoom`, now step views placed with `setView`;
`query.sampleHeightNowMany`; `input.ctrlWheelZoom`, now the `ctrlWheel`
zoom input), `depthFailColor` and `depthFailDash` became one `depthFail`
style, and quality settings became detail only. The Cesium port and the
stub follow those changes.

Some members and options were added to version `0` later. Each is
optional:

- `globe.isGlobeVisible()` (capability `globeVisibility`) reads back whether
  the globe surface is shown, for code that holds only the scene.
- `camera.followFrame()` (capability `followFrame`) reads the frame the eye
  is placed in, as a column-major 4×4 matrix to ECEF: a follow's own frame
  (east-north-up, or the orbit frame `autodetect` chose), a `lookAt`
  target's east-north-up frame, or the identity. `setView` keeps that frame
  while it places a world pose. A share link's follow offset is
  re-expressed in it, satellites included.
- `globe.surfaceVersion()` (capability `surfaceIdentity`) is a number that
  changes whenever what surface heights answer against changes (base,
  terrain or photoreal route swapped, the globe shown or hidden) and never
  otherwise (not on camera moves or tile loads), so the application can key cached
  heights by it. `isSettled('surface')` says whether that surface has
  loaded what is in view; a renderer without it answers `surface` as `base`.
- `SurfaceShading` is `hillshade`: view-lit shading of the drawn terrain's
  own relief (the ellipsoid's curvature where terrain has no normals) that
  only darkens, at most `strength` opacity. The Cesium port draws it as a
  globe material it takes only while no one else holds the globe's
  material.
- Fields: `windStreamlines` takes `alpha` (changed without a rebuild) and
  `paused`; `rasterShell` replaces `detailWindow` with
  `detail: {image, rectangle}`, a sharper image drawn in place of the base
  one, and says how shells stack, blend and update. `FieldHandle.on('drawn')`
  says once per spec or `update` that it is drawn, never while hidden. These
  change `fields` itself rather than add to it, so the renderer follows
  them where it lists `fields`. The Cesium adapter lists `fields` and
  draws `rasterShell` and `windStreamlines`. It reads the grid's samples as
  points, the first column at `rectangle.west` and the first row at
  `rectangle.north`, rows running south. Over the whole globe its paths
  wrap east and west; over part of it they seed inside the rectangle,
  equal-area, and stop at its edges.
- `ModulationSector` gains `radius` and `floor` and says what it modulates:
  icons, points and models dimmed toward `floor` outside the band, the map,
  lines and shapes as they are, picks unchanged. Its pass is named
  `screenModulation`. This changes `screenModulation` itself; only the stub
  lists it, and the Cesium adapter does not draw it yet.
- `camera.on('changed', cb, { threshold })` measures each listener by its
  own threshold under the capability `cameraChangeThreshold`; a renderer
  without it fires every `changed` listener at 0.5.
- A line item's `depthFail` style, solid or dashed, draws the parts behind
  the surface (the Draw tool's rubber band is dashed there too); without one
  they are hidden.
- A solid line's `outline.widthPx` is the outline's whole width, half on
  each side, inside the line's own width: an 8 px line with a 4 px outline
  is 2 px of outline, 4 px of colour and 2 px of outline, as Cesium draws
  it. The check `draw.lines.outline` pins it.
- A shape's `lit` chooses shading by the renderer's fixed light (true) or a
  flat colour (false); omitted, extruded shapes are lit and the rest flat,
  as before. The Cesium port lights unclamped shapes only
  (clamped ones drape unlit). The `shapes-lit` scene draws both.
- `SetSpec.recede` (`RecedeSpec`, for icon and model sets) makes a set's
  items shrink and fade toward the globe's limb, replacing the icon item's
  own `recede` flag. Its parameters (each optional: where receding starts
  as a share of the limb's distance, the scale and haze reached at the
  limb, the least focus × haze draws with, and the eye heights over which
  it all eases off for a view of the whole globe) and the maths are
  `render/recession`'s, so the renderer draws exactly those factors: an icon
  draws at its scale times the scale factor, and an icon or model at its
  alpha times `max(combinedAlphaFloor, focus × haze)`. `ModelItem.focus`
  dims a model as `IconItem.focus` dims an icon. It changes live
  (`setOptions`). The Cesium port draws a receding icon set on the GPU,
  the factors worked out in its shader, and fades a receding model set's
  models each frame before the scene draws, writing a model's colour again
  once its focus and haze move by more than 0.005. The check
  `draw.sets.recede` makes and changes both kinds, and
  `draw.sets.recede.models` reads a receding model's pixels: at focus 0.25
  it draws faded, and a `combinedAlphaFloor` of 1, set live, brings it back.
- `SetSpec.drawOrder` stacks sets drawn over depth: a higher one draws over
  a lower one and is picked first; equal ones keep the order they were
  made in. The Cesium port stacks opaque icons and points by it;
  translucent ones blend order-independently there.
- A rectangle shape's `rotation` (radians counter-clockwise) turns it about
  its centre in longitude and latitude, as a KML ground overlay turns, and
  its image fill turns with it. The Cesium port drapes image fills too, each
  on a ground primitive of its own.
- `camera.controls.keepEarthFramed` (capability `keepEarthFramed`) stops
  the user's outward zooms at a whole-Earth view (about 40,000 km, or
  higher where a camera command left the eye) and, from high up, turns the
  view down toward the globe so the whole Earth stays in frame; camera
  commands are not held to it and end its turn. The Cesium port eases the
  view until the Earth's limb is 8° below its centre line above 300 km
  (`zoomOutGuard.js`). The application turns it on where a renderer has it.
- `query.occlusionTest()` (capability `occlusionTest`) tests many points
  against the depth of the frames drawn without waiting for the GPU; the
  detection overlay leaves out the street vehicles it finds hidden. The
  Cesium port builds its test with `gods-eye-view/render/occlusion`
  (`createDepthOcclusionTest`, given a `DepthSource`: depth packed into
  RGBA8 or a depth texture, standard or logarithmic, with the view it was
  drawn from).
- `RendererPlugin.applicationHooks(renderer)` hands the application what
  lies beside the contract (`ApplicationHooks`); see
  [The application and its renderer](#the-application-and-its-renderer).
- `frame.renderNow()` throws when the frame fails to draw. With
  `{ifDue: true}` it runs one tick of the loop now, as the loop's own would
  (camera flight, input, clock), and draws only a frame that is due.

The Cesium port lists `gpuTiming` where its context has
`EXT_disjoint_timer_query_webgl2`: while anyone listens to frame signals,
each drawn frame is timed on the GPU from `preRender` to `postRender`, and a
signal carries `gpuMs` of the newest frame whose timing has come back (a
frame or more late; a disjoint timing is dropped). Without the extension it
answers `gpuTiming: 'none'` and lists no capability. The check
`quality.signals.gpuTiming` pins both.

The Cesium port lists `modelAtmosphere`: Cesium scatters drawn models
through the atmosphere in the same stage as its distance fog, so models take
it while `globe.sky`'s `fog` is on.

`weather` adds `globe.weather`: clouds, fog, haze, rain and snow drawn
around the view, each a strength from 0 to 1, with the wind they drift on.
`src/render/weather.js` (exported as `./render/weather`) keeps and clamps
them (`mergeWeather`), and `./weather/effects`
turns a weather observation into strengths (`deriveWeatherEffectProfile`).
The application sets none, and the Cesium port does not list it. The strengths say what
is observed (`clouds` is the fraction of the sky covered), not how it is
drawn: the renderer draws clouds, fog and haze its own way, with clouds
placed by scene time and the wind, and shading the ground under them where
the sun lights it. The checks `globe.weather`, `globe.weather.drawn` and
`globe.weather.sceneTime` (pixel checks) pin it.

How the sky, atmosphere, haze, lighting and the frame's tone mapping and
exposure look is the renderer's own: `globe.sky` switches parts on and
off, and no check compares colours. With
`atmosphere`, `fog` and `lighting` off and clear weather a renderer applies
none of its look, so the checks that read an exact colour (`bareSky` in
`checks/ports.js`) set that sky first. The
reference images under `src/render/conformance/goldens/visual/` are the
Cesium renderer's own, for checking it against itself.

The Cesium port lists `followAutodetect`: an `autodetect` follow is
Cesium's own AUTODETECT tracking frame, east-north-up on a still or slow
target and an orbit frame (x along the inertial motion, z up) on a fast
one. The stub's is a frame along the ground track, so an autodetect
`viewFrom` reads differently on each; the check `camera.follow.autodetect`
pins what both share (the range kept, north-up when still, the frame on the
target standing up).

A follow target's `transitionS` makes the first framing a move instead of a
jump: from its first frame the eye is in the target's frame, and over
`transitionS` seconds of wall time it goes from where it stood to
`viewFrom`, by the one rule in `src/render/camera/followTransition.js`
(its offset and its view each turned and eased with smoothstep, the view
ending on the target with no roll). The Cesium port, the stub and a camera
controller import that rule rather than restating it. The tracked aircraft
and followed trains use it with a `viewFrom` taken from the camera
at the click: the eye's own view direction at its own range from the target,
so neither changes and only the eye's place moves, sliding the target to the
centre. The check `camera.follow.transition` pins it.

The Cesium port draws clamped shapes of every kind. A clamped outline is a
draped line (a ground polyline a ring, under the shape's pick id; an outlined
clamped shape is rebuilt on any change; a pulsing one pulses through its line's
material, as an image fill pulses through its image material's colour). What
a ground primitive cannot drape stands on the surface unclamped, the surface
read when the set is built: an extruded shape from the lowest surface height
under it up to its `extrudeHeight`, a wall with its foot on the surface under
each position and its heights above it, and an image fill where the scene
cannot drape materials (no depth textures). The check `draw.shapes.clamped`
draws each.

The Cesium port takes every kind of `ImageRef` wherever an image is drawn
(icons on billboards and on the GPU, line patterns, shape fills, quads and
raster shells): a URL, SVG, a blob (by an object URL made once per blob,
revoked once the blob itself has been collected; a material drawing a blob,
a quad's among them, holds it while it lives, since a material loads its image
on its first draw, even after the atlas slot it came from has a new one; a
quad given another source lets the old blob go with its old material, once the
frame has drawn), a
keyed canvas, and an atlas slot as the image it holds (an icon waits for an
unregistered slot; anything else refuses it). The check `draw.icons.images`
draws each kind on still icons and in a set that recedes.

Icon sets with `cluster` (`ClusterSpec`) cluster the same way on every
renderer: `clusterScreenPoints` (`src/geo/screenCluster.js`) over the shown
icons in front of the eye and above the horizon, in the set's order, boxed at
their drawn size, the last pass's clusters kept. A cluster draws one icon at
the mean of its members' positions in place of its members (`icon(count)`,
else a default badge with the count, at the seed's size). A pick on it
answers one hit a member, seed first, each with the member's own `set`, `id`
and `meta` and the cluster's position, so `pick` gives the seed and
`drillPick` every member. Clusters are made again in the frames drawn after
the camera moves or the set changes, never on a timer. The Cesium port draws
a set's cluster icons in a billboard collection of their own and hides the
members' billboards. A set on the GPU (`columns`, a set that recedes, or moving,
proxy-picked or level-of-detail icons) clusters its rows where their segments
(and ground) put them at the frame's motion-clock time, hiding the members'
rows; while rows still move it clusters again every frame. The checks
`draw.icons.cluster` and `draw.motion.cluster` (members coming to rest on
their segments) draw a cluster, pick it, and part it by moving in.

Icon sets on the Cesium GPU path draw what its billboards draw: pixel offsets, `bottom` and `top` anchors, screen and axis
rotations (turned as Cesium's billboards turn), `fadeByDistance`,
`displayRange`, and `clampGround` / `relativeGround` heights. Each row reads
these from a float texture by instance, so the 16 vertex attributes hold;
WebGL 1 has no such fetch and refuses them. A clamped row stands on the
ground taken between the heights under its segment's two ends, sampled after
a frame draws, 256 ends a frame across the port's sets: loaded terrain first,
then (but for `clampTo: 'terrain'`) the drawn surface, eight a frame. They are
sampled again when the globe's tiles finish loading and, clamped to more than
terrain, every 5 s. The check `draw.motion.look` draws each on a moving icon.

A set's `blend` holds for every kind of set: omitted, opaque parts draw
opaque with depth writes and translucent ones blend without; `opaque` draws
every item opaque, its alpha ignored, with depth writes; `translucent` blends
every item without depth writes, even at alpha 1; `additive` adds each item's
colour times its alpha, without depth writes and still depth-tested. It
changes live (`setOptions`, from the next frame; models do not load again).
The Cesium port builds billboards and points in Cesium's blend options, and
turns every set's draw commands to its blend each frame before the scene
sorts them (`src/render/cesium/setBlend.js`): additive ones draw after every
opaque command and before the translucent pass, which blends
order-independently and would undo the addition; ground commands keep their
pass and stencil and only blend differently. The checks `draw.sets.blend`
(points, icons, lines, shapes) and `draw.models.blend` read the pixels.

A model item may bring its glTF bytes (`gltf`): the renderer builds it from
them and never fetches its `url`, which stays the model's identity, so a
model set loaded up front (the procedural fleet models, GLBs compressed with
`EXT_meshopt_compression` and `KHR_mesh_quantization`) is never fetched
mid-session. `axisScale` stretches a model along its own glTF axes on top of
`scale` (a hull drawn at its reported beam), `maskColor` paints a colour
where the model's `_TINT` vertex attribute marks it (a vehicle in its route's
colour), and `clip: 'belowOrigin'` draws only what is above the horizontal
plane through its position (a hull above its waterline). Each changes live.
The Cesium port passes the bytes as the model's `gltf` with its url as the
base path, scales its model matrix along the axes Cesium's glTF axis
correction turns them to, paints the mask in a custom shader per colour
(unlit under `unlit` shading, left out under `thermal`), and clips with a
clipping plane through the model's origin. The checks `draw.models.bytes`
and `draw.models.fleet` cover them.

The Cesium port draws timed imagery (`imageryFrames`): a layer given a timed
source hides its own imagery and draws each frame its clock shows as a Cesium
imagery layer just above it (in `blend` mode the later frame over the earlier
at its share of the way, as a layer's `alpha` blends), with the next
`prefetch` frames (1 by default) loading unseen at alpha 0. A video source is
seen every 250 ms of each segment (at most 1,200 times a segment), each tile
the video its URL names for it (or one video over the layer's rectangle for a
`single-image` layer), seeked to the time's share of its length. A layer
keeps its 48 most recently seen tile videos; a tile waiting on one it lets
go, or on a seek that takes over 10 s (60 s for the seek past its end that
learns the length of a video that does not state it), fails rather than
waiting. A video whose seek did not end is let go, so the next tile loads a
fresh one; one that failed to load (or to say how long it is) fails its tiles
at once for 3 minutes, then loads again. `frameReady`
names the nearest frame's time once every globe tile drawn shows that
frame's own imagery (`src/render/cesium/imageryFrames.js`). The checks
`globe.imagery.frames` and `globe.imagery.video` cover both.

Every Cesium draw set takes `setColumns` (`columns`): icon sets on the GPU,
any other as the rows the columns make over the items it holds, each row the
item of that id with the columns' fields over it, replacing every item as
`set` does (`columnRows` in `src/render/cesium/draw.js`, as the stub does).
`renderer.shape` holds on Cesium.

The Cesium port also draws `pattern` line styles (the image repeated
`repeat` times along the line, in the translucent pass; draped too), lines in the
`inertial` frame (turned each frame by the set's motion clock, a depth-fail
style included; never batched; a draped one is draped where the sky is,
turned into the fixed frame, and draped again each second of its clock),
segment colours and shows
on lines of every mode and style (a draped solid line as ground instances,
any other as a primitive a segment with a material of its own, recoloured
and shown in place; an arrow's head on its last segment, a pattern keeping
its image; the check `draw.lines.segmentStyles`), and image fills on clamped ellipses, cut finely so a
round image (the launch pad zone's rim) runs round. A clamped colour fill
whose geometry alone changes (an annotation's target ring, resized as the
camera climbs) is drawn alone where it now is, in the same frame. A hidden
line that cannot settle into a static batch leaves its polyline collection
until it shows again, since the collection draws every line it holds.

The renderer itself (`renderer.d.ts`) adds capture, pixel reads, settling,
resize, context loss and `destroy`. `common.d.ts` holds the shared shapes
(ECEF positions, colours, listener semantics) and the capability list.

The rules that hold everywhere:

- **The application keeps its own records.** It never reads a renderer to learn its own
  state, only what the renderer measures: picks, depth, heights and
  readiness.
- **Capabilities.** An optional member (`?`) exists only with the capability
  its documentation names first. A required member that names a capability
  always exists, and without the capability it answers null or empty.
  Quality support is listed by `quality.knobs()`, not by capabilities.
- **Picks see the scene before effects.** A style that moves pixels does not
  move what is picked, so the application maps a pointer through its own
  style first
  (`src/input/sensorPick.js`). A bounded `drillPick` (`limit`) also bounds
  its work: it looks through at most `max(limit, 16)` things under the
  pointer.
- **Heights are physical.** All heights are metres above the ellipsoid,
  unexaggerated. Only drawing follows exaggerated terrain.
- **Listeners** run in subscription order. A listener removed during
  delivery does not run; one added during delivery runs from the next event.
  A listener that throws is reported to the renderer's `error` event, or to
  the platform's `reportError` when nothing listens for errors. The other
  listeners, and the frame, still run.
- **The frame order is fixed:** camera flight → input → camera `changed` →
  follow → `preUpdate` → move detection → `preRender` → render →
  `postRender`, the default renderer's own. A camera move made by follow or
  in `preUpdate` is reported by `changed` on the next frame.
- **Destroy ends everything.** After `destroy()`, every handle does
  nothing: a set's or field's methods neither draw nor throw, and a set or
  field asked for afterwards is such a handle. The same holds for one handle
  after its own `dispose()`. `frame.renderOnce()` and `capture()` reject
  with a "renderer destroyed" error, and a `renderOnce` still waiting at
  destroy rejects rather than hang.
- **Results are read-only.** `camera.matrices()` and `followFrame()` may
  hand the same arrays again while they hold, and hand new ones once they
  change, so one kept from an earlier frame stays as it was.
- **Reading the frame.** `capture()` and `readPixels()` read the last
  presented frame; neither draws one of its own when the frame is kept.
  Whether to keep the drawing buffer is the renderer's own business, not a
  creation option. The creation options a renderer takes are `msaa`, `sky`
  and `time`, set before the first frame, and `clock`, which its frame
  ticks, the camera's `moveEnd` wait, its input and its flights read, and
  its inertia where the renderer times that itself: on Cesium, inertia
  keeps Cesium's own timing.
- **Leases:** a tool takes the pointer with `claimPointer`. With `grab`, it
  takes only the presses it grabs on `down`; the rest, and wheel and pinch,
  stay with the camera and everyone else. The newest claim takes over: it
  ends the previous lease, whose `onLost` is called once, after the new lease
  holds the pointer, so that tool turns itself off. A lease its holder
  releases is never told, and an ended lease's release frees nothing.
  The application's own tools (Draw, the imagery box, Directions) claim through
  `src/data/inputOwnership.js`, which the input dispatcher bridges onto the
  port, so a claim on either takes over from the other. The bridge's lease
  grabs no press: the dispatcher decides who hears each event when it
  arrives, and the renderer's stock select and double-click follow run
  unless a tool holds them off.

`src/render/contract/index.js` lists every member of every port in `PORTS`,
along with `CAPABILITIES`, `FRAME_STEPS` and `QUALITY_KEYS`.
`checkRendererShape(renderer)` names each required member that is missing,
and each capability member present without its capability.
`contract.test.mjs` type-checks the contract under strict TypeScript, and
fails when `PORTS` and the types disagree on a single member.

### The vector base painter

`vectorBase` (`BaseSpec.vector = { styleUrl }`) draws a MapLibre style
document's vector tiles as the globe's base. They are painted in shared,
Cesium-free code, `src/render/vectorBase/`, which the renderer draws as
imagery:

- `loadVectorStyle(styleUrl, fetch)` fetches the style and the TileJSON its
  vector sources name (a source's `url`; inline `tiles` are used as given,
  resolved against the style), compiles every layer, and returns the
  sources (tile templates, `minzoom`, `maxzoom`, `xyz` or `tms`), the layers
  it draws, the background, the sources' attributions, and `skipped`: each
  layer it does not draw, with why.
- `paintVectorTile(style, z, x, y, { size, fetch, signal, canvas })` paints
  one Web Mercator tile on a canvas at style zoom `z + log2(size / 512)` (at
  least 0). A source past its `maxzoom` is drawn from its deepest tile,
  overzoomed; below its `minzoom` it draws nothing. Decoded source tiles
  (gzipped ones inflated) are kept per style, the last 128.

What it draws of the style specification:

- Layers: `background` (`background-color`, `background-opacity`); `fill`
  (`fill-color`, `fill-opacity`, `fill-outline-color`); `line`
  (`line-color`, `line-width`, `line-opacity`, `line-dasharray`,
  `line-cap`, `line-join`, and `line-gap-width` drawn as one line the full
  cased width); `circle` (`circle-radius`, `circle-color`,
  `circle-opacity`, `circle-stroke-width`, `circle-stroke-color`,
  `circle-stroke-opacity`); `symbol` text only (`text-field` as an
  expression or with `{name}` tokens, `text-size`, `text-font` as the
  system's sans-serif or serif in bold or italic as its name says,
  `text-color`, `text-opacity`, `text-halo-color`, `text-halo-width`,
  `text-transform`, `text-anchor`, `text-offset`, `text-max-width`).
  Layer `minzoom`, `maxzoom`, `filter` and `visibility` hold.
- Labels are painted into the tiles: top layer first (within a layer, its
  features in their order in the tile), each clear of those placed before
  it and wholly inside its tile (one across a tile edge is
  left out). A point labels at itself, a line halfway along it (level, not
  along the line), a polygon at its outer ring's bounding-box centre.
- Filters in both syntaxes (legacy, with `$type` and `$id`, and
  expressions). Legacy `{stops, base, property, type}` functions
  (exponential, interval, categorical, identity; not zoom-and-property);
  one without a `type` is exponential on a property that interpolates (a
  number or colour) and interval on any other (`line-cap`, `line-join`,
  `text-font`, `text-transform`, `text-anchor`, ...), as the specification
  says. `has`, `get` and legacy filters see a feature's own properties only.
- Expressions: `literal`, `get`, `has`, `id`, `geometry-type`, `zoom`,
  `properties`, `!`, `all`, `any`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`,
  `case`, `match`, `coalesce`, `step`, `interpolate` (`linear` and
  `exponential`; `-hcl` and `-lab` blend in RGB), `to-string`,
  `to-number`, `to-boolean`, `to-color`, `number`, `string`, `boolean`,
  `rgb`, `rgba`, `concat`, `format` (its text), `upcase`, `downcase`,
  `length`, `at`, and arithmetic (`+ - * / % ^`, `min`, `max`, `abs`,
  `floor`, `ceil`, `round`, `sqrt`, `ln`, `log10`, `log2`).
- Skipped whole: `fill-extrusion`, `raster`, `hillshade`, `heatmap` and
  `sky` layers; layers on raster sources; layers setting a pattern
  (`fill-pattern`, `line-pattern`, `background-pattern`), `line-offset`,
  `line-gradient` or a translation; layers whose values use an expression
  not listed (or are malformed). As MapLibre does, a paint or layout value
  that cannot be evaluated for a feature (a type that does not fit, a
  `step` or `interpolate` over what is not a number) or is not of the
  property's kind (null; not a finite number, a string included, where a
  number is needed; not a colour `parseColor` reads, which takes the CSS
  colour names; not one of the property's keywords) is the property's
  default; a legacy function's miss is its `default`, else the property's.
  A feature whose filter cannot be evaluated is left out. Nothing
  unsupported throws.
- Ignored: icons (`icon-image`, sprites: a symbol layer draws its text
  alone), text along lines (drawn level), `glyphs` (system fonts), and any
  other paint or layout property not listed above.

The Cesium port loads the style before the base changes (a style that fails
leaves the base as it was; a later `setBase`, or disposal, aborts the load and
the overtaken call changes nothing, resolving with `imagery: []` and
`settled: false`; `settled` is whether, when the call resolves, its base is
still the one drawn and has settled, so an earlier call that resolves while a
later call's style is still loading, or after that style fails, is settled,
and one that resolves after a later call changed the base is not), draws it as Web Mercator imagery under the
base's other imagery (`src/render/cesium/vectorBase.js`, 256 px tiles to
level 20, transparent where the style paints no opaque background; a tile
whose request is cancelled, its layer removed, is not painted), and credits each source's attribution as plain text. The stub
loads the style and paints nothing. The check `globe.base.vector` serves a
style and a tile from data URLs and reads the drawn fill.

### What a renderer does, by role

A renderer is more than a drawing surface: it is a whole globe engine. The
application keeps the data (providers, records, layers and their
behaviour). The renderer owns everything from a source spec or a draw set
down to the pixels. The ports follow the API's shape; `ROLES` in
`src/render/contract/index.js` names what the engine behind them does, and
puts every member of `PORTS` in exactly one role. It changes no member.

| Role      | What it does                                                                                                | Members                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `surface` | Streams, decodes and builds the globe from map sources: imagery, terrain, photoreal 3D tiles, draped layers | `globe`, `imageryLayer`, `credits`                                                     |
| `scene`   | Draws the application's data as keyed, retained sets                                                        | `draw`, `drawSet`                                                                      |
| `view`    | Places and moves the camera, hands pointer input to the application                                         | `camera`, `flight`, `input`, `lease`                                                   |
| `queries` | Picks, surface positions and heights, rays, projection, occlusion                                           | `query`                                                                                |
| `look`    | Sky and atmosphere, surface shading, per-layer lighting, styles and screen effects                          | `effects`, `globe.sky`, `globe.weather`, `globe.setSurfaceShading`, `imageryLayer.lit` |
| `host`    | Canvas and life cycle, the frame loop and scene time, quality, capture, settling                            | `renderer`, `frame`, `quality`                                                         |

An entry is a port or a `port.member` prefix; the most specific one wins, so
`roleOf('globe', 'sky.set')` is `'look'` while `roleOf('globe', 'setBase')`
is `'surface'`. `contract.test.mjs` fails when a member has no role, when
two roles claim the same entry, or when an entry names no member.

## Moving code onto the contract

Two ratchet tests keep code that has moved onto the contract from drifting
back to Cesium. Both lists only ever shrink.

- `src/render/cesiumAllowList.json` lists the files outside the Cesium
  adapter (`src/render/cesium/`) that may still import or be handed Cesium
  (`src/render/noCesiumOutsideRender.test.mjs`). A file leaves the list
  when it no longer drives Cesium at all; nothing is added. The list is
  empty: no file outside the adapter reaches Cesium. Two files name
  the adapter by design and are not on it: the application scene
  (`src/app/scene.js`), the composition root that picks the default renderer
  when it is given none, may import `src/render/cesium/application.js` (only
  then, so a page on the stub never loads Cesium) and nothing else of
  the adapter; the conformance page (`dev/conformance/main.js`) may import the
  adapter's harness and scene renderer. The test names both
  (`ADAPTER_ENTRIES`), and that list is never grown.
- `src/render/viewerAccessAllowList.json` counts, per file off that list,
  the Cesium-shaped accesses through the viewer it still makes (none: the
  list is empty, so no file may make one)
  (`src/render/viewerAccess.test.mjs`): the viewer's `entities`,
  `dataSources`, `scene`, `camera`, `clock`, `imageryLayers`,
  `terrainProvider`, `trackedEntity` and `canvas`, and the scene's
  `primitives`, `pick`, `drillPick`, `pickPosition`, `globe`, `preRender`,
  `postRender`, `preUpdate`, `postUpdate`, `canvas`, `requestRender` and
  `camera`, written plainly, with `?.`, in brackets or destructured.
  `viewer.container` is a DOM element and does not count; reach the canvas
  through `canvasOf(viewer)`. Comments and tests do not count.
  `src/testSupport/viewerAccess.mjs` is the matcher.
  A file may not make more accesses than recorded (a file not listed may
  make none), and a count higher than the file now needs fails too. So a
  file that leaves the Cesium list must port its viewer accesses in the
  same change: it cannot be added to the count. After
  porting accesses away, run `node scripts/viewer-access-baseline.mjs` (or
  `--check` to see what it would change): it lowers counts and drops
  entries, and never adds or raises one.

## The application and its renderer

The application runs on a renderer with only the contract's required
members (the stub proves it below); nothing outside `src/render/<renderer>/` asks which renderer it runs
on (no `renderer.id`, no engine type, no engine object's presence).

- **The scene object.** `createApplicationScene` (`src/app/scene.js`) takes a
  `RendererPlugin`, or a promise of one (default: Cesium, imported only then;
  `loadDefaultRenderer` starts that import as the standalone page starts),
  creates the renderer in the page's container, and hands every layer and
  tool the application's own scene object (`createSceneHost` in
  `src/render/rendererOf.js`): the container and `isDestroyed()`, bound to
  the renderer. Code reaches the renderer's
  ports through it (`findCamera`, `drawOf`, `canvasOf`...).
- **What only the Cesium renderer needs at startup** is done in its
  plugin's `create`: the free-look height limit and keyboard access to its
  credits' expand link (`src/render/cesium/appRenderer.js`).
- **What a plugin may hand the application beside the contract** is its
  `applicationHooks(renderer)` (`ApplicationHooks`,
  `src/render/contract/renderer.d.ts`), asked once as the scene creates the
  renderer and recorded for the application (`src/render/applicationHooks.js`):
  a map engine of its own, stale command trimming, whether an entity is its
  own, whether it shows its credits in a display of its own
  (`ownCreditDisplay`; otherwise the application's own line,
  `src/ui/creditsView.js`, shows the credits port's list), and what QA
  scripts read from `window.__godsEyeView` (Cesium's viewer there, for the
  scripts that drive it). Each is optional, none is a contract member, and
  a renderer without them runs the application without that behaviour.
- **What the renderer should do is in the ports**, each through the
  application's own code: outward zooms stop at a whole-Earth view that
  stays framed (`camera.controls.keepEarthFramed`, which the scene turns
  on; Cesium's is `src/render/cesium/zoomOutGuard.js`); the detection
  overlay leaves out street vehicles something stands in front of through
  `query.occlusionTest()` under the `occlusionTest` capability (the GPU
  probe is `src/render/occlusion/depthProbe.js`, which Cesium's
  `src/render/cesium/sceneOcclusionProbe.js` feeds; without it every such
  vehicle's bracket shows); and an inline panel whose host stops animation
  frames keeps running through `resize` and `frame.renderNow({ifDue: true})`
  (`src/app/panelRendering.js`), so flights, input and the clock go on as
  in the renderer's own loop, stopping at a frame that throws.
- **The map stacks** switch through the renderer's own map engine when its
  plugin hands one, else through its globe port (`src/maps/globeEngine.js`);
  see `docs/CURRENT-STATE.md` § Map source factories and coordination.
- **The proof.** `npm run qa:stub-boot` (`scripts/qa-stub-boot.mjs`) serves
  the application's page with `dev/stub-app/main.js` as its entry: the whole
  application on the stub with no capability at all. It fails when the page
  requests any Cesium module or asset, when the credits line is not shown
  with its data credits, on a page or console error, or when a
  data layer (flights, military aircraft, transit, traffic, CCTV, vessels,
  weather, wind, satellites, FIRMS, wildlife, shipwrecks, news) fails to
  turn on or off; `--strict` also fails
  a layer that draws nothing on the stub (it needs the live feeds).
  `src/app/scene.test.mjs` runs the scene itself on the stub in Node.

## The stub renderer

`createStubRenderer({ capabilities, viewport, time, container })` implements
every port in memory and draws nothing. Given a `container` (in a page), its
canvas is a real canvas filling it, which `resize()` follows; otherwise a
stand-in that takes event listeners. `createStubRendererPlugin(options,
onCreate)` is the stub as a `RendererPlugin`. It has:

- the default camera's exact maths: views, `lookAt`, flights with their
  height arc and easing, `changed` thresholds and follows;
- picks against what was drawn, or a scripted table;
- scripted heights;
- a virtual clock that nothing advances on its own;
- models that load at once, but for urls under `stub-fail:`
  (`STUB_FAILING_MODEL_SCHEME`), which fire `loadFailed` instead of `ready`
  (they are still picked where they are).

`renderer.testing` drives it with `tick()`, `advance(ms)`, `pointer(type, x, y)`,
`scriptPicks`, `setHeights` and `cacheHeight`, and records its calls.
`testing.drawnPosition({ set, id }, aheadMs)` is where it draws an item now
(or `aheadMs` from now), so a
camera controller over the stub can follow drawn items there.
A listener that throws with nothing subscribed to `error` goes to
`reportError`; Node has none, so the stub rethrows it on a microtask and
`node:test` fails the running test. A test that expects a throw subscribes
to `error`.
The stub passes the whole conformance suite (`src/render/stub/stub.test.mjs`).

## Conformance suite

`runConformance(harness)` runs every check against the Cesium renderer or
the stub through the contract alone and reports each one as passed, failed or skipped. It runs in
Node and in a browser page. A harness tells the suite how to drive the
renderer under test:

- `create({ viewport, capabilities })`;
- `frame(r)`: one frame, 1/60 s on a virtual clock;
- `now(r)` and `toEcef(p)`;
- `tolerance` and `flightPaths`.

Optional members widen what is checked: `pointer` for synthetic input,
`cameraInput` (the camera answers that input: the drag and wheel traces
run), `scriptHeights`, `resizeContainer` (sizes the element the renderer
fills, for the `resize` check, which skips without it), `assets.model`, and
`assets.missingModel` (a model url that fails to load, for the `loadFailed`
check). `pixels: false` says
the renderer draws nothing but models into its pixels, as the stub: the
checks that read drawn icons, lines and fields then skip. Without it they
run, and the renderer fails them if it draws nothing there.

There are two layers of checks.

**Logic checks** run in CI. They cover:

- the shape check;
- listener semantics and the frame loop;
- draw-set bookkeeping, picks and the `meta` round-trip;
- projection, rays and heights;
- leases and click picks;
- imagery order, sky, styles, credits and quality knobs;
- the camera traces.

**Camera traces.** `cameraScripts.js` lists camera scripts in the contract's
terms. `scripts/record-camera-goldens.mjs` runs them on Cesium's own
`Camera`, headless, on a virtual clock, and writes
`src/render/conformance/goldens/camera.json`. A renderer under test must
match each recorded pose:

- within 1 mm in position, 1e-9 in unit vectors and angles, and 1e-3 px on
  screen;
- with every flight ending within one frame of the recording.

Some scripts move the camera by user input: left, middle, Shift and Ctrl
drags, and wheels in pixel and line mode. The recorder runs those on
Cesium's own `ScreenSpaceCameraController`, fed the DOM events the script
describes, with `Date` on the virtual clock too (its coasting reads it). A
renderer under test gets them through its harness's `pointer`, a wheel as
the input port's lines. Only a harness with `cameraInput` runs them: the
stub's camera takes no gestures, so it skips them; a camera controller
over the stub would run them. `cameraPort.test.mjs` runs them on Cesium's
controls under the Cesium camera port, each wheel sent back as lines.

A wheel's `delta` is lines as Cesium counts them: a pixel-mode wheel at
40 px a line and a page at 3 lines (`src/render/input/wheel.js`). Turning
lines back into pixels at 40 px a line gives Cesium's own wheel in every
mode, so a controller that does that zooms as Cesium does in Chrome (pixel
mode) and Firefox (line mode) alike.

`src/render/cesium/cameraGoldens.test.mjs` fails when the installed Cesium
no longer records the committed traces. After a Cesium upgrade or a script
change, run `node scripts/record-camera-goldens.mjs` and review the diff.

**Visual checks** run in the browser. The reference scenes
(`src/render/conformance/scenes.js`) are built from contract calls only:

- one scene per primitive family;
- a city scene;
- a calibration path from orbit down to the street.

The scenes load nothing from the network.

`npm run dev`, then open `/dev/conformance/`. The page can:

- **Run logic suite (stub)** runs the logic checks in the browser.
- **Record references** draws every scene the chosen renderer supports.
  It saves each view to `src/render/conformance/goldens/visual/`, through a
  dev-server-only endpoint.
- **Check scenes** draws the scenes again and compares each capture with its
  reference. Pixels are compared as pixelmatch compares them: by YIQ
  difference (threshold 0.1), with antialiasing in either image excused. A
  capture matches when at most 250 pixels are unexcused and at most 2 are
  solid (a differing pixel whose four neighbours differ too). Between them
  the two catch a dropped 4 px point, a dropped 2 px line and a 1 px shift
  of the view, and pass any MSAA setting. A change nowhere 3 px thick (a
  thin line gone, an item moved a pixel or two) that covers at most 250 px
  passes. `visual.js` has the measurements.
  The page shows the capture, the reference and the difference side by side.

`window.conformance.runScenes()` and `runLogic()` do the same from a script.

`npm run qa:conformance` runs the logic checks on the Cesium renderer in
headless Chromium (software WebGL, no GPU needed). It starts its own Vite
server unless given `--url`; `--only id,id` runs just those checks and
`--json path` writes the report. It fails on any failed check and on any
skip it does not expect (`query.heights`, which needs scripted heights, is
the one it expects). CI runs it in the `street-level-browser` job.
Browser checks use the chrome-devtools MCP against a page in its own window.

The Cesium scene renderer (`src/render/cesium/sceneRenderer.js`) draws
every scene (icons, points, lines, shapes, models, quads, meshes, fields
and the city), and the references were recorded with it, on a GPU: a
software rasterizer such as SwiftShader draws the glow line differently.
It has only the members the scenes need.

Some behaviour is only drawn, so the logic checks cannot see it: course
easing (`courseGlide`), and a hidden row keeping its eased
course. The stub keeps no drawn course. These wait for scenes that capture
an icon mid-turn. Height queries that count a set
(`includeInHeightQueries`) are not checked either: the stub's heights are
scripted, so it does not model them. Nor are video frames (a check needs a
video) or `fetchTile` (the stub fetches nothing).

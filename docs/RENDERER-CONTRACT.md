# Renderer contract

The renderer contract is what the application asks of a 3D renderer. A
renderer other than the default Cesium one can draw the same application if
it meets the contract. The contract is version `0`. Today the application
still drives Cesium directly; later work moves the layers onto the contract
one family at a time.

The package exports four modules:

| Export                               | What it is                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `gods-eye-view/render/contract`      | The types, one `.d.ts` per port, plus the run-time member list and shape check         |
| `gods-eye-view/render/stub`          | A renderer that draws nothing, for tests                                               |
| `gods-eye-view/render/camera/events` | The camera port's events: `changed` per listener, `moveStart`/`moveEnd`, command hooks |
| `gods-eye-view/render/conformance`   | The conformance suite, reference scenes and visual comparison                          |

A camera of its own (a camera controller over a renderer without one) can
take the camera events from `render/camera/events` and the geodesy it needs
(`geodesicAt`, `horizonFrom` and the rest) from `gods-eye-view/geo`, so it
measures and fires exactly as the stub does.

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
style, and quality settings became detail only. A renderer written against
an earlier `0` follows those changes.

Some members and options were added to version `0` later. Each is
optional, so a renderer written before it still conforms:

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
  `fields` before must follow them. The Cesium adapter lists `fields` and
  draws `rasterShell` and `windStreamlines`. It draws streamlines only over
  the whole globe: it reads the grid's samples as points, the first column
  at `rectangle.west` and the first row at `rectangle.north`, rows running
  south, and traces paths that wrap east and west, so it refuses a grid
  short of 360° of longitude.
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
- `SetSpec.drawOrder` stacks sets drawn over depth: a higher one draws over
  a lower one and is picked first; equal ones keep the order they were
  made in. The Cesium port stacks opaque icons and points by it;
  translucent ones blend order-independently there.
- A rectangle shape's `rotation` (radians counter-clockwise) turns it about
  its centre in longitude and latitude, as a KML ground overlay turns, and
  its image fill turns with it. The Cesium port drapes image fills too, each
  on a ground primitive of its own. A renderer that predates it draws the
  rectangle unturned.
- `camera.controls.keepEarthFramed` (capability `keepEarthFramed`) stops
  the user's outward zooms at a whole-Earth view (about 40,000 km, or
  higher where a camera command left the eye) and, from high up, turns the
  view down toward the globe so the whole Earth stays in frame; camera
  commands are not held to it and end its turn. The Cesium port eases the
  view until the Earth's limb is 8° below its centre line above 300 km
  (`zoomOutGuard.js`). The application turns it on where a renderer has it.
- `query.occlusionTest()` (capability `occlusionTest`) tests many points
  against the depth of the frames drawn without waiting for the GPU; the
  detection overlay leaves out the street vehicles it finds hidden. A WebGL
  renderer that hands over its frame's depth gets one from
  `@gods-eye-view/core/render/occlusion` (`createDepthOcclusionTest`, given a
  `DepthSource`: depth packed into RGBA8 or a depth texture, standard or
  logarithmic, with the view it was drawn from).
- `RendererPlugin.applicationHooks(renderer)` hands the application what
  only some renderers have (`ApplicationHooks`); see
  [The application and its renderer](#the-application-and-its-renderer).
- `frame.renderNow()` throws when the frame fails to draw.

The Cesium port lists `modelAtmosphere`: Cesium scatters drawn models
through the atmosphere in the same stage as its distance fog, so models take
it while `globe.sky`'s `fog` is on.

The Cesium port lists `followAutodetect`: an `autodetect` follow is
Cesium's own AUTODETECT tracking frame, east-north-up on a still or slow
target and an orbit frame (x along the inertial motion, z up) on a fast
one. The stub's is a frame along the ground track, so an autodetect
`viewFrom` reads differently on each; the check `camera.follow.autodetect`
pins what both share (the range kept, north-up when still, the frame on the
target standing up).

The Cesium port takes every kind of `ImageRef` wherever an image is drawn
(icons on billboards and on the GPU, line patterns, shape fills, quads and
raster shells): a URL, SVG, a blob (by an object URL made once per blob), a
keyed canvas, and an atlas slot as the image it holds (an icon waits for an
unregistered slot; anything else refuses it). The check `draw.icons.images`
draws each kind on still and receding icons.

The Cesium port also draws `pattern` line styles (the image repeated
`repeat` times along the line, in the translucent pass), lines in the
`inertial` frame (turned each frame by the set's motion clock; never draped
and never batched), and image fills on clamped ellipses, cut finely so a
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
- **Leases:** a tool takes the pointer with `claimPointer`. With `grab`, it
  takes only the presses it grabs on `down`; the rest, and wheel and pinch,
  stay with the camera and everyone else.

`src/render/contract/index.js` lists every member of every port in `PORTS`,
along with `CAPABILITIES`, `FRAME_STEPS` and `QUALITY_KEYS`.
`checkRendererShape(renderer)` names each required member that is missing,
and each capability member present without its capability.
`contract.test.mjs` type-checks the contract under strict TypeScript, and
fails when `PORTS` and the types disagree on a single member.

### What a renderer does, by role

A renderer is more than a drawing surface: it is a whole globe engine. The
application keeps the data (providers, records, layers and their
behaviour). The renderer owns everything from a source spec or a draw set
down to the pixels. The ports follow the API's shape; `ROLES` in
`src/render/contract/index.js` names what the engine behind them does, and
puts every member of `PORTS` in exactly one role. It changes no member.

| Role      | What it does                                                                                                | Members                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `surface` | Streams, decodes and builds the globe from map sources: imagery, terrain, photoreal 3D tiles, draped layers | `globe`, `imageryLayer`, `credits`                                    |
| `scene`   | Draws the application's data as keyed, retained sets                                                        | `draw`, `drawSet`                                                     |
| `view`    | Places and moves the camera, hands pointer input to the application                                         | `camera`, `flight`, `input`, `lease`                                  |
| `queries` | Picks, surface positions and heights, rays, projection, occlusion                                           | `query`                                                               |
| `look`    | Sky and atmosphere, surface shading, per-layer lighting, styles and screen effects                          | `effects`, `globe.sky`, `globe.setSurfaceShading`, `imageryLayer.lit` |
| `host`    | Canvas and life cycle, the frame loop and scene time, quality, capture, settling                            | `renderer`, `frame`, `quality`                                        |

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
  `create`: for Cesium, the free-look height limit and keyboard access to its
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
  frames keeps drawing through `resize` and `frame.renderNow()`
  (`src/app/panelRendering.js`), stopping at a frame that throws.
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
camera that is not the stub's own can follow drawn items there.
A listener that throws with nothing subscribed to `error` goes to
`reportError`; Node has none, so the stub rethrows it on a microtask and
`node:test` fails the running test. A test that expects a throw subscribes
to `error`.
The stub passes the whole conformance suite (`src/render/stub/stub.test.mjs`).

## Conformance suite

`runConformance(harness)` runs every check against a renderer through the
contract alone and reports each one as passed, failed or skipped. It runs in
Node and in a browser page. A harness tells the suite how to drive the
renderer under test:

- `create({ viewport, capabilities })`;
- `frame(r)`: one frame, 1/60 s on a virtual clock;
- `now(r)` and `toEcef(p)`;
- `tolerance` and `flightPaths`.

Optional members widen what is checked: `pointer` for synthetic input,
`cameraInput` (the camera answers that input: the drag and wheel traces
run), `scriptHeights`, `assets.model`, and `assets.missingModel` (a model
url that fails to load, for the `loadFailed` check). `pixels: false` says
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

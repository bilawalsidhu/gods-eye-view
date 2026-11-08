# Renderer contract

The renderer contract is what the application asks of a 3D renderer. A
renderer other than the default Cesium one can draw the same application if
it meets the contract. The contract is version `0`. Today the application
still drives Cesium directly; later work moves the layers onto the contract
one family at a time.

The package exports three modules:

| Export                             | What it is                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `gods-eye-view/render/contract`    | The types, one `.d.ts` per port, plus the run-time member list and shape check |
| `gods-eye-view/render/stub`        | A renderer that draws nothing, for tests                                       |
| `gods-eye-view/render/conformance` | The conformance suite, reference scenes and visual comparison                  |

## Ports

A renderer is created by a `RendererPlugin` (`{ id, create(options) }`). It
exposes nine ports, each typed in its own file in `src/render/contract/`:

| Port      | File           | Covers                                                                         |
| --------- | -------------- | ------------------------------------------------------------------------------ |
| `frame`   | `frame.d.ts`   | The render-on-demand loop, frame phases, continuous holds, scene time          |
| `globe`   | `globe.d.ts`   | Base (photoreal, terrain, vector, imagery), imagery layers, split, sky         |
| `draw`    | `draw.d.ts`    | Draw sets: icons, points, lines, shapes, models, quads, meshes, fields, agents |
| `camera`  | `camera.d.ts`  | Pose, views, flights, `lookAt`, follow, user controls, events, matrices        |
| `query`   | `query.d.ts`   | Picks, projection, rays, heights                                               |
| `input`   | `input.d.ts`   | Pointer events with their pick made, leases, stock behaviours                  |
| `effects` | `effects.d.ts` | Screen styles, bloom, sharpen, screen modulation                               |
| `credits` | `credits.d.ts` | Data credits owed                                                              |
| `quality` | `quality.d.ts` | Quality knobs, device facts, frame signals, benchmark                          |

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
- `SurfaceShading` has a `hillshade` kind: view-lit shading of the drawn
  terrain's own relief (the ellipsoid's curvature where terrain has no
  normals) that only darkens, at most `strength` opacity. The Cesium port
  draws it as a globe material it takes only while no one else holds the
  globe's material; it has no `relief` kind.
- Fields: `windStreamlines` takes `alpha` (changed without a rebuild) and
  `paused`; `rasterShell` replaces `detailWindow` with
  `detail: {image, rectangle}`, a sharper image drawn in place of the base
  one, and says how shells stack, blend and update. `FieldHandle.on('drawn')`
  says once per spec or `update` that it is drawn, never while hidden. These
  change `fields` itself rather than add to it, so the renderer follows
  `fields` before must follow them; only the stub lists it, and the Cesium
  adapter has no `fields` yet.
- `camera.on('changed', cb, { threshold })` measures each listener by its
  own threshold under the capability `cameraChangeThreshold`; a renderer
  without it fires every `changed` listener at 0.5.
- A line item's `depthFailDash` (`{ length, pattern16? }`) dashes the parts
  behind the surface in `depthFailColor`, as the Draw tool's rubber band is.
  A renderer that predates it draws those parts solid.
- A shape's `lit` chooses shading by the renderer's fixed light (true) or a
  flat colour (false); omitted, extruded shapes and boxes are lit and the
  rest flat, as before. The Cesium port lights unclamped shapes only
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

The Cesium port also draws `pattern` line styles (the image repeated
`repeat` times along the line, in the translucent pass), lines in the
`inertial` frame (turned each frame by the set's motion clock; never draped
and never batched), and `radialRim` fills on clamped ellipses (`rimWidth` a
fraction of the radius; `depthBias` pulls the fill toward the eye). A hidden
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

## Moving code onto the contract

Two ratchet tests keep code that has moved onto the contract from drifting
back to Cesium. Both lists only ever shrink.

- `src/render/cesiumAllowList.json` lists the files outside the Cesium
  adapter (`src/render/cesium/`) that may still import or be handed Cesium
  (`src/render/noCesiumOutsideRender.test.mjs`). A file leaves the list
  when it no longer drives Cesium at all; nothing is added.
- `src/render/viewerAccessAllowList.json` counts, per file off that list,
  the Cesium-shaped accesses through the viewer it still makes
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

## The stub renderer

`createStubRenderer({ capabilities, viewport, time })` implements every port
in memory and draws nothing. It has:

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
`scriptHeights`, `assets.model`, and `assets.missingModel` (a model url
that fails to load, for the `loadFailed` check).

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

The Cesium scene renderer (`src/render/cesium/sceneRenderer.js`) draws the
icon, point, line, shape, model and city scenes, and the references were
recorded with it. It has only the members the scenes need. The quad, mesh,
field, agent and orbit scenes have no reference yet. Each family's reference
is recorded when the Cesium renderer gains that family.

Some behaviour is only drawn, so the logic checks cannot see it: course
easing (`courseBlendMs`, `courseGlide`), and a hidden row keeping its eased
course. The stub keeps no drawn course. These wait for scenes that capture
an icon mid-turn. Height queries that count a set
(`includeInHeightQueries`) are not checked either: the stub's heights are
scripted, so it does not model them. Nor are video frames (a check needs a
video), `fetchTile` (the stub fetches nothing) or what clouds and water
draw.

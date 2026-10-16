// The engine-neutral globe contract. The application shell talks to a globe
// engine (Cesium today, Navara next) only through these small capability
// objects. Positions are src/geo values in Earth-fixed metres, angles are
// radians and screen coordinates are CSS pixels from the canvas's top-left
// corner. This module and src/globe/testing/** never import cesium, three or
// @navaramap/*; see docs/CODE-BOUNDARIES.md.

/**
 * @typedef {{ x: number, y: number }} Cartesian2
 * @typedef {{ x: number, y: number, z: number }} Cartesian3
 * @typedef {{ longitude: number, latitude: number, height: number }} Cartographic
 * @typedef {number[]} Matrix4 16 numbers, column-major (m[column * 4 + row]).
 * @typedef {(...args: any[]) => void} Listener
 *
 * @typedef {object} EngineEvent
 *   The contract's own event semantics (engines expose createEngineEvent()
 *   instances, never a raw Cesium.Event):
 *   - listeners run in registration order;
 *   - adding a function that is already registered is a no-op (it stays
 *     registered once and fires once), so re-initialisation cannot double-fire;
 *   - a listener removed during dispatch is not called in that dispatch;
 *   - a listener added during dispatch runs from the next dispatch, and one
 *     removed then re-added during dispatch stays registered;
 *   - every remover handle is idempotent and only removes the registration it
 *     was returned for.
 * @property {(listener: Listener) => () => void} addEventListener
 * @property {(listener: Listener) => boolean} removeEventListener
 *
 * @typedef {object} CameraPose
 *   Angles follow Cesium's camera: heading in [0, 2π) clockwise from north,
 *   pitch in [−π/2, π/2] (negative looks down), roll in [0, 2π) with positive
 *   roll tilting `up` toward the camera's right; roll is 0 and heading follows
 *   `up` when looking (nearly, within 1e-3) straight up or down.
 * @property {Cartesian3} position World position (Cesium's positionWC).
 * @property {Cartographic} cartographic
 * @property {number} heading
 * @property {number} pitch
 * @property {number} roll
 * @property {Cartesian3} direction
 * @property {Cartesian3} up
 * @property {Cartesian3} right direction × up
 * @property {number} fovy Vertical field of view.
 * @property {number} aspectRatio The view's width over its height (Cesium:
 *   the frustum's, from the drawing buffer).
 *
 * @typedef {{ heading: number, pitch: number, roll: number }
 *   | { direction: Cartesian3, up: Cartesian3 }} Orientation
 *
 * @typedef {{ west: number, south: number, east: number, north: number }} Rectangle
 *   Radians; west > east across the antimeridian. As a destination, the
 *   camera is placed so the rectangle fills the view (Cesium's
 *   getRectangleCameraCoordinates).
 *
 * @typedef {object} FlightOptions
 * @property {Cartesian3 | Rectangle} destination
 * @property {Orientation} [orientation] As in Cesium's setView and flyTo,
 *   missing angles default to heading 0, pitch −π/2 and roll 0 (they do not
 *   keep the current ones).
 * @property {number} [duration] Seconds. 0 (or less) sets the view and calls
 *   `complete` synchronously, before flyTo returns, as Cesium does.
 * @property {'cubicInOut'|'sinusoidalInOut'|'linear'} [easing] Omitted: the
 *   engine's own flight easing (Cesium picks one from the flight's heights).
 * @property {Matrix4} [endTransform] The camera transform once the flight
 *   lands; IDENTITY releases a lookAt lock.
 * @property {() => void} [complete]
 * @property {() => void} [cancel] Called by cancelFlight or a newer flight.
 *
 * @typedef {{ heading: number, pitch: number, range: number }} HeadingPitchRange
 *   Offset from a target in its local east-north-up frame; the camera looks at
 *   the target along heading/pitch from `range` metres away.
 *
 * @typedef {object} SphereFlightOptions
 *   Defaults are Cesium's: heading 0, pitch −π/4 and, when range is missing or
 *   0, range = 100 m for a sphere of radius 0, otherwise
 *   max(r / tan(fovx/2), r / tan(fovy/2)) clamped to the camera controller's
 *   zoom distances (Cesium: minimumZoomDistance 1 m to maximumZoomDistance ∞
 *   by default).
 * @property {number} [heading]
 * @property {number} [pitch]
 * @property {number} [range]
 * @property {number} [duration]
 * @property {'cubicInOut'|'sinusoidalInOut'|'linear'} [easing] As in FlightOptions.
 * @property {() => void} [complete]
 * @property {() => void} [cancel]
 *
 * @typedef {object} GlobeCamera
 * @property {() => CameraPose} pose Fresh values on every call.
 * @property {Cartesian3} livePosition The pose's world position as one
 *   engine-owned object: the same object on every read, holding the current
 *   position (at the latest when read). For per-frame readers, which must not
 *   allocate; read-only, copy it to keep a value.
 * @property {() => number} height The camera's height above the WGS84
 *   ellipsoid (the pose's cartographic height), without building a pose.
 * @property {(view: { destination: Cartesian3 | Rectangle, orientation?: Orientation }) => void} setView
 *   Missing angles default to heading 0, pitch −π/2, roll 0.
 * @property {(options: FlightOptions) => void} flyTo Cancels a running flight first.
 * @property {(sphere: { center: Cartesian3, radius: number }, options?: SphereFlightOptions) => void} flyToSphere
 *   Ends unlocked (identity transform).
 * @property {() => boolean} flightActive
 * @property {(target: Cartesian3, offset: HeadingPitchRange) => void} lookAt
 *   lookAtTransform(eastNorthUp(target), offset).
 * @property {(transform: Matrix4, offset?: HeadingPitchRange | Cartesian3) => void} lookAtTransform
 *   Locks the camera to `transform`; a Cartesian3 offset is the camera position
 *   in that frame, looking at its origin with the frame's +Z as "up". Without
 *   an offset the camera keeps its world pose.
 * @property {() => Matrix4} transform A copy of the current camera transform.
 * @property {() => void} release lookAtTransform(IDENTITY).
 * @property {() => void} cancelFlight
 * @property {(amount?: number) => void} zoomIn Moves `amount` metres along direction.
 * @property {(amount?: number) => void} zoomOut Moves `amount` metres against direction.
 * @property {() => ({ west: number, south: number, east: number, north: number } | undefined)} viewRectangle
 *   Cesium's computeViewRectangle: undefined when the globe is out of view;
 *   west > east across the antimeridian; ±π longitudes and a ±π/2 latitude
 *   over a pole; the whole globe when fewer than two canvas corners hit it.
 * @property {(screen: Cartesian2) => (Cartesian3 | undefined)} pickEllipsoid
 * @property {(screen: Cartesian2) => { origin: Cartesian3, direction: Cartesian3 }} pickRay
 * @property {EngineEvent} changed Listener receives the change fraction.
 * @property {EngineEvent} moveStart Fires when the camera starts moving from rest.
 * @property {EngineEvent} moveEnd Fires once the camera has been still for a
 *   while (Cesium: scene.cameraEventWaitTime, 500 ms), so a move that follows
 *   within that time continues the same movement and raises no new moveStart.
 * @property {EngineEvent} commanded Fires (no arguments) when a command, not a
 *   user gesture, is about to take the camera: setView, flyTo, flyToSphere,
 *   lookAt and cancelFlight. Cesium also raises it for those calls made on the
 *   viewer's own camera and when the viewer's tracked entity changes, so a
 *   pending correction yields to every new camera owner.
 * @property {(options: FollowOptions) => FollowHandle} follow Keeps a moving
 *   target in the centre (Cesium: trackedEntity; Navara and the fake engine:
 *   src/globe/follow.js each frame). The user may turn and zoom around it;
 *   a command that takes the camera (setView, flyTo, flyToSphere, lookAt,
 *   cancelFlight) ends it. A new follow replaces the current one.
 * @property {() => (FollowHandle | null)} following The current follow
 *   (Cesium: also one the app started on viewer.trackedEntity itself).
 * @property {EngineEvent} followChanged Listener receives the new handle or
 *   null (Cesium: viewer.trackedEntityChanged).
 * @property {number} percentageChanged
 *
 * @typedef {object} FollowOptions
 * @property {() => Cartesian3} position Where the target is (read each frame).
 * @property {Cartesian3 | (() => Cartesian3)} viewFrom The camera's offset
 *   from the target in its east-north-up frame, metres.
 * @property {number} [minRange] Closest the camera comes (150 m).
 * @property {'enu'} [frame]
 * @property {any} [native] Cesium only (layers' render/cesium.js): the
 *   Entity to put on viewer.trackedEntity instead of a proxy.
 *
 * @typedef {object} FollowHandle
 * @property {() => void} stop
 * @property {(next: Partial<FollowOptions>) => void} retarget
 * @property {any} [native]
 *
 * @typedef {'click'|'doubleClick'|'move'|'down'|'up'} InputType
 * @typedef {'ctrl'|'shift'|'alt'} InputModifier
 * @typedef {object} InputEvent
 * @property {Cartesian2} [position] click, doubleClick, down, up.
 * @property {Cartesian2} [startPosition] move.
 * @property {Cartesian2} [endPosition] move.
 * @property {PickResult} [picked] With `pick`: what is drawn under the
 *   position (move: the end position), undefined for the map or nothing.
 *   Cesium picks at once; Navara answers a click from its GPU pick of the
 *   same gesture (a frame or two later; undefined after a timeout), a move
 *   from a CPU pick of movers and lines, at most once per frame.
 * @property {PickResult[]} [drilled] With `drill`: up to that many objects
 *   under the position, nearest first.
 *
 * @typedef {object} InputOptions
 * @property {InputModifier} [modifier]
 * @property {boolean} [pick] click, doubleClick and move only. A move
 *   listener with pick gets at most one payload per frame (the latest).
 * @property {number} [drill] A positive integer (click and doubleClick).
 *
 * @typedef {object} GlobeProjector
 * @property {(position: Cartesian3, result?: Cartesian2) => (Cartesian2 | undefined)} worldToWindow
 *   Undefined behind the camera; fills and returns `result` when given.
 * @property {(result?: Matrix4) => Matrix4} viewProjection
 *   World → clip matrix consistent with worldToWindow: clip = M·[x, y, z, 1],
 *   in front when clip.w > 0, window = ((clip.x/clip.w + 1)/2 · width,
 *   (1 − clip.y/clip.w)/2 · height).
 * @property {(position: Cartesian3) => boolean} horizonVisible
 *   False when the WGS84 ellipsoid hides the point from the camera
 *   (Cesium's EllipsoidalOccluder.isPointVisible).
 *
 * @typedef {object} GlobeSurface
 * @property {(cartographic: Cartographic, exclude?: any[]) => (number | undefined)} sampleHeight
 *   Height of the rendered scene (tiles, models) under a point.
 * @property {(cartographic: Cartographic, options?: { exclude?: any[], lod?: 'visible' | 'finest' }) => (SurfaceHeight | undefined)} sampleHeightDetailed
 *   sampleHeight with the answer's quality (src/globe/surfaceDetail.js):
 *   lod 'visible' (default) answers from the tiles drawn now, 'finest' from
 *   the finest loaded ones (Navara; Cesium samples what it has loaded).
 *   Where no tile answers, the terrain. `exclude` takes this engine's mover
 *   sets as well as engine objects.
 * @property {boolean} supported Whether sampleHeight works.
 * @property {(cartographic: Cartographic) => (number | undefined)} terrainHeight
 *   Height of the terrain/globe surface only (Cesium's globe.getHeight).
 * @property {boolean} terrainHeightSupported
 * @property {(position: Cartesian3, exclude?: any[]) => (Cartesian3 | undefined)} clampToHeight
 *   The position moved onto the rendered scene along the geodetic normal.
 * @property {boolean} clampToHeightSupported
 * @property {() => boolean} tilesLoaded
 *
 * @typedef {object} SurfaceHeight
 * @property {number} height Metres above the ellipsoid.
 * @property {'tiles' | 'terrain'} source
 * @property {number} [tileSizeM] The size of the tile that answered
 *   (Navara): the quality signal; Cesium does not say.
 *
 * @typedef {object} GlobeRender
 * @property {(reason?: string) => void} request Renders a frame soon in
 *   request mode; `reason` is for diagnostics only.
 * @property {(enabled: boolean) => void} setContinuous
 *   Owns whatever the engine needs to render every frame or only on request
 *   (Cesium: requestRenderMode and maximumRenderTimeChange = Infinity).
 * @property {() => boolean} isContinuous
 * @property {(options: { enabled?: boolean, amount?: number }) => void} setSharpen
 *   An unsharp mask on the final image, after tone mapping and before
 *   anti-aliasing: each pixel moves away from its 3×3 box blur by `amount`
 *   (the maths of the app's Cesium sharpen stage, whose `amount` uniform the
 *   Sharpen slider sets in 0.1..2.1). Omitted fields keep their value; a
 *   non-boolean `enabled` or a negative or non-finite `amount` throws a
 *   TypeError. Off with amount 1 until set. The Cesium engine only keeps the
 *   state: in Cesium mode the app's own post stage sharpens and mirrors its
 *   state here (src/ui/visualEffects.js).
 * @property {() => { enabled: boolean, amount: number }} sharpen
 *   The sharpening last set (a copy).
 *
 * @typedef {object} PickResult
 * @property {any} id The picked entity or object id (a mover's or line's
 *   pickId); undefined for map tiles.
 * @property {string} [owner] The mover set or line the pick belongs to.
 * @property {number} [instance] The mover instance index.
 * @property {any} [primitive] Cesium only, for compatibility.
 * @property {any} [content] 3D tile content when map tiles were picked (what
 *   a surface-pick check reads), else undefined.
 * @property {any} [object] The engine's own pick result, for engine-specific code.
 *
 * @typedef {object} GlobeMaps
 *   Map sources are engine-neutral descriptions, as maps/registry.js sources
 *   carry them; each engine builds its own providers from them:
 *   - imagery `{ kind: 'osm'|'esri-imagery'|'ion', style?, accessToken?,
 *     credit?, descriptor? }`;
 *   - photoreal tiles `{ kind: 'photoreal', googleApiKey?, cesiumToken?,
 *     credit?, descriptor? }`;
 *   - terrain `{ kind: 'ellipsoid'|'keyless'|'world', accessToken?, id? }`.
 *   Optional prebuilt members (`provider`, `tileset`, terrain `create`, an
 *   `imagery()` factory) are engine objects their caller built and owns: only
 *   the engine kind that built them uses them (the Cesium engine for the
 *   registry's Cesium factories), any other ignores them and builds from the
 *   description. The engine neither caches nor disposes them.
 *   Each setter settles once the source is on screen and rejects when it
 *   cannot be built (the current source then stays). Base imagery and
 *   photoreal tiles share one switch order: the call made last decides what
 *   shows, and a superseded call settles without showing anything.
 * @property {(source: object) => Promise<void>} setBaseImagery
 * @property {(source: object) => Promise<void>} setTerrain
 * @property {(source: object | null) => Promise<void>} setPhotorealTiles
 *   Tiles replace the base imagery and hide the globe; null hides every
 *   tileset and shows the globe again with the last base imagery and its
 *   credit (no credit when none was set).
 * @property {(source: object) => void} releasePhotorealTiles Forgets a
 *   photoreal source shown before (it no longer counts for photorealActive)
 *   and takes engine-added tiles out of the scene; its caller disposes them.
 * @property {() => boolean} photorealActive
 * @property {() => { baseImagery: object | null, photoreal: object | null }} current
 *   The source objects on screen, as passed: the base imagery layer on the
 *   globe and the photoreal tiles shown (null for none).
 *
 * @typedef {object} GlobeClock
 *   The app's own time (src/time/clock.js), in milliseconds since the Unix
 *   epoch: the one time source for layers and the engine's own time-driven
 *   drawing (Navara's sun). By default it is the wall clock (Date.now); QA
 *   and tests may freeze, offset or speed it up on the app clock: now()
 *   follows at once, frameTime() and ticked from the engine's next frame, and
 *   in request-render mode nothing draws until a render is requested, so a
 *   QA helper that moves the clock calls render.request() after it.
 *   Not on this clock yet (each moves when its layer or code moves):
 *   - Cesium's viewer.clock: the app never animates it (shouldAnimate false,
 *     its time frozen at boot); Cesium's sun and lighting and every entity
 *     property read at viewer.clock.currentTime stay on that time;
 *   - launches: the replay timeline (replay.js, Date.now/performance.now),
 *     the mission orbit's GMST frame (orbitRendering.js new Date()), launch
 *     pad and panel throttles (phase 3 Task 15a);
 *   - satellites: the point cloud's SGP4 propagation and orbit bake
 *     (rendering.js new Date()/Date.now) (Task 14a); only the tracked
 *     satellite reads the app clock;
 *   - wall-clock throttles and feed receipt stamps everywhere (they measure
 *     real elapsed time, not scene time).
 * @property {() => number} now The current app time.
 * @property {() => number} frameTime The app time latched at the start of the
 *   engine's current frame: every reader in one frame gets the same value; it
 *   does not decrease from frame to frame while the app clock runs forward.
 *   Before the first frame, the current time.
 * @property {EngineEvent} ticked Raised once per engine frame, with the
 *   frame time, before that frame's preUpdate (and so before preRender). A
 *   frame is one turn of the engine's update loop, also when it draws
 *   nothing: Cesium raises it on the viewer clock's tick, right before
 *   scene.render (which raises preUpdate on every animation frame, drawn or
 *   not); Navara on the view's preUpdate, which it emits on every turn of
 *   its loop.
 *
 * @typedef {object} MoverSetOptions
 *   A set of moving objects drawn as one batch (src/globe/movers.js checks
 *   and defaults these):
 * @property {string} id Unique among the engine's live sets.
 * @property {'sprite'|'point'|'model'} kind
 * @property {number} capacity The most instances the set holds.
 * @property {number} [order] Draw order among sets (higher draws later, on
 *   top); 0 by default.
 * @property {'normal'|'always'|{ disableWithinM: number }} [depthTest]
 *   'always' draws over the scene; { disableWithinM } skips the depth test for
 *   instances closer to the camera than that (Cesium's
 *   disableDepthTestDistance). 'normal' by default.
 * @property {{ atlas: { url?: string, canvas?: object, cells: Object<string, number[]> },
 *   sizePx: number, scaleByDistance?: number[] }} [sprite] An image atlas
 *   whose cells are [u0, v0, u1, v1] in 0..1 (v down from the image top);
 *   each sprite is a square of sizePx CSS px times its scale, times the
 *   NearFarScalar [nearM, nearScale, farM, farScale] when given.
 * @property {{ sizePx: number, outlinePx?: number, scaleByDistance?: number[] }} [point]
 *   A filled disc of sizePx CSS px diameter with a dark outline.
 * @property {{ url: string, minimumPixelSize?: number, maximumScale?: number,
 *   colorBlend?: { mode: 'mix'|'replace', amount: number }, unlit?: boolean }} [model]
 *   A glTF drawn per instance in metres, at least minimumPixelSize px.
 * @property {boolean} [pickable]
 *
 * @typedef {object} MoverFields
 *   One instance; omitted fields keep their value (defaults: white, scale 1,
 *   rotation 0, the first atlas cell, shown, identity orientation).
 * @property {Cartesian3} [position]
 * @property {number} [rotation] Sprites: screen angle in radians,
 *   counter-clockwise from screen up (Cesium's Billboard.rotation).
 * @property {{ x: number, y: number, z: number, w: number }} [orientation]
 *   Models: the model frame's rotation into Earth-fixed axes.
 * @property {number[]} [color] rgba in 0..1; multiplies the sprite's texels.
 * @property {number} [scale]
 * @property {string} [cell] An atlas cell key.
 * @property {boolean} [show]
 * @property {string|number} [pickId] What a pick of this instance returns.
 *
 * @typedef {object} MoverSet
 * @property {(index: number, fields: MoverFields) => void} set Stored only;
 *   drawn after commit().
 * @property {(count: number) => void} setCount Instances [0, count) draw.
 * @property {() => number} count
 * @property {() => void} commit Uploads what changed (one buffer write) and
 *   requests a render; nothing else draws a frame.
 * @property {() => Float64Array} positionsView x, y, z of the drawn
 *   instances (a view on the set's own array; read-only).
 * @property {() => void} destroy
 *
 * @typedef {object} GlobeMovers
 * @property {(options: MoverSetOptions) => MoverSet} createSet
 * @property {() => { id: string, kind: string, count: number, capacity: number }[]} list
 *
 * @typedef {object} LineOptions
 *   A dynamic polyline (src/globe/lines.js checks and defaults these).
 * @property {string} id Unique among the engine's live lines.
 * @property {number} widthPx Width in CSS pixels.
 * @property {number[]} color rgba in 0..1.
 * @property {number} [depthFailAlpha] 0..1: where the scene hides the line, a
 *   copy drawn with its alpha scaled by this (Cesium's depthFailAppearance);
 *   0 (the default) draws nothing there.
 * @property {{ lengthPx: number, gapPx: number } | 'tactical'} [dash]
 *   Dashes in pixels along the screen direction (Cesium's PolylineDash), or
 *   the launches' selected-orbit pattern over the whole line.
 * @property {'none'|'geodesic'} [arc] 'geodesic' follows great circles
 *   between points (Cesium's ArcType.GEODESIC); 'none' (default) draws
 *   straight segments.
 * @property {Matrix4} [modelMatrix] Applied to the positions (an orbit ring
 *   turned by GMST).
 * @property {any} [pickId] What a Cesium pick of the line returns (Navara
 *   lines are not pickable yet).
 *
 * @typedef {object} Line
 * @property {(positions: Cartesian3[] | Float64Array) => void} setPositions
 * @property {(color: number[]) => void} setColor
 * @property {(matrix: Matrix4) => void} setModelMatrix
 * @property {(visible: boolean) => void} show
 * @property {() => void} destroy
 *   Every call requests a render; nothing animates on its own.
 *
 * @typedef {object} GlobeLines
 * @property {(options: LineOptions) => Line} createLine
 * @property {() => { id: string, points: number, shown: boolean }[]} list
 *
 * @typedef {object} GlobeEngine
 * @property {'cesium'|'navara'} kind
 * @property {{ container: object, canvas: object, size: () => { width: number, height: number } }} host
 * @property {GlobeCamera} camera
 * @property {{ pick: (screen: Cartesian2, width?: number, height?: number) => (PickResult | undefined), drillPick: (screen: Cartesian2, limit?: number, width?: number, height?: number) => PickResult[], pickPosition: (screen: Cartesian2) => (Cartesian3 | undefined), pickPositionSupported: boolean, pickGlobe: (screen: Cartesian2) => (Cartesian3 | undefined) }} picker
 *   pickGlobe: where the ray through a window position meets the globe
 *   surface (terrain, not tiles or models; Cesium's globe.pick of the camera's
 *   pick ray); an engine without a terrain surface answers the ellipsoid.
 *   pickPosition reads the depth of the last drawn frame: after a camera change,
 *   request a render and wait a frame before reading it.
 * @property {GlobeProjector} projector
 * @property {{ preUpdate: EngineEvent, preRender: EngineEvent, postRender: EngineEvent }} frames Listeners receive a timestamp in ms.
 * @property {GlobeRender} render
 * @property {GlobeSurface} surface
 * @property {{ on: (type: InputType, listener: (event: InputEvent) => void, options?: { modifier?: InputModifier }) => () => void, setCameraInputs: (enabled: boolean) => void }} input
 *   As in Cesium, a listener with a modifier fires only while that key is
 *   held and one without fires only while no modifier is held.
 * @property {{ addStatic: (html: string, options?: { onScreen?: boolean }) => () => void }} credits
 * @property {GlobeMaps} maps
 * @property {GlobeClock} clock
 * @property {GlobeMovers} movers
 * @property {GlobeLines} lines
 * @property {() => void} destroy
 * @property {() => boolean} isDestroyed True once destroy() has run.
 */

export const ENGINE_KINDS = Object.freeze(['cesium', 'navara']);
export const INPUT_TYPES = Object.freeze([
  'click',
  'doubleClick',
  'move',
  'down',
  'up',
]);
export const MODIFIERS = Object.freeze(['ctrl', 'shift', 'alt']);
/** Input types whose listeners may ask for picks. */
export const PICK_INPUT_TYPES = Object.freeze(['click', 'doubleClick', 'move']);

/**
 * input.on options checked and defaulted: { modifier, pick, drill } (drill
 * 0 when not asked), or a TypeError.
 */
export function normalizeInputOptions(type, options = {}) {
  const { modifier, pick = false, drill = 0 } = options ?? {};
  if (!INPUT_TYPES.includes(type))
    throw new TypeError(`Unknown input type: ${type}`);
  if (modifier !== undefined && !MODIFIERS.includes(modifier))
    throw new TypeError(`Unknown input modifier: ${modifier}`);
  if (typeof pick !== 'boolean')
    throw new TypeError(`Input pick must be a boolean: ${pick}`);
  if (!(Number.isInteger(drill) && drill >= 0))
    throw new TypeError(`Input drill must be a whole number: ${drill}`);
  if ((pick || drill) && !PICK_INPUT_TYPES.includes(type))
    throw new TypeError(`Input ${type} cannot pick`);
  if (drill && type === 'move') throw new TypeError('A move cannot drill');
  return { modifier, pick: pick || drill > 0, drill };
}
export const FLIGHT_EASINGS = Object.freeze([
  'cubicInOut',
  'sinusoidalInOut',
  'linear',
]);

const ENGINE_EVENT = Symbol('gev.globe.engineEvent');

/** Whether a value is an event made by createEngineEvent. */
export const isEngineEvent = (value) =>
  value != null && value[ENGINE_EVENT] === true;

/**
 * An event with the contract's semantics (see EngineEvent). `raiseEvent` and
 * `raiseValue` (one argument, no argument list: for per-frame events) are for
 * engine implementations; a listener that throws propagates, and the event
 * stays usable.
 */
export function createEngineEvent() {
  let entries = [];
  let depth = 0;
  let removedDuringRaise = false;
  const active = (listener) =>
    entries.find((entry) => entry.listener === listener);
  const removeEntry = (entry) => {
    if (!entry.listener) return false;
    entry.listener = null;
    if (depth) removedDuringRaise = true;
    else entries.splice(entries.indexOf(entry), 1);
    return true;
  };
  const settle = () => {
    depth--;
    if (!depth && removedDuringRaise) {
      entries = entries.filter((entry) => entry.listener);
      removedDuringRaise = false;
    }
  };
  const event = {
    get numberOfListeners() {
      return entries.reduce(
        (count, entry) => count + (entry.listener ? 1 : 0),
        0,
      );
    },
    addEventListener(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('Engine event listener must be a function');
      let entry = active(listener);
      if (!entry) {
        entry = { listener };
        entries.push(entry);
      }
      return () => {
        removeEntry(entry);
      };
    },
    removeEventListener(listener) {
      const entry = active(listener);
      return entry ? removeEntry(entry) : false;
    },
    raiseEvent(...args) {
      const snapshot = entries;
      const length = snapshot.length;
      depth++;
      try {
        for (let index = 0; index < length; index++) {
          const listener = snapshot[index].listener;
          if (listener) listener(...args);
        }
      } finally {
        settle();
      }
    },
    // raiseEvent(value) without an argument list, for per-frame events.
    raiseValue(value) {
      const snapshot = entries;
      const length = snapshot.length;
      depth++;
      try {
        for (let index = 0; index < length; index++) {
          const listener = snapshot[index].listener;
          if (listener) listener(value);
        }
      } finally {
        settle();
      }
    },
  };
  Object.defineProperty(event, ENGINE_EVENT, { value: true });
  return event;
}

const isFunction = (value) => typeof value === 'function';
const isObject = (value) =>
  value != null && (typeof value === 'object' || typeof value === 'function');
const isBoolean = (value) => typeof value === 'boolean';
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Capability → member → predicate. Members not listed here are free extensions.
const SHAPE = {
  host: { container: isObject, canvas: isObject, size: isFunction },
  camera: {
    pose: isFunction,
    livePosition: (value) =>
      value != null &&
      isNumber(value.x) &&
      isNumber(value.y) &&
      isNumber(value.z),
    height: isFunction,
    setView: isFunction,
    flyTo: isFunction,
    flyToSphere: isFunction,
    flightActive: isFunction,
    lookAt: isFunction,
    lookAtTransform: isFunction,
    transform: isFunction,
    release: isFunction,
    cancelFlight: isFunction,
    zoomIn: isFunction,
    zoomOut: isFunction,
    viewRectangle: isFunction,
    pickEllipsoid: isFunction,
    pickRay: isFunction,
    changed: isEngineEvent,
    moveStart: isEngineEvent,
    moveEnd: isEngineEvent,
    commanded: isEngineEvent,
    follow: isFunction,
    following: isFunction,
    followChanged: isEngineEvent,
    percentageChanged: isNumber,
  },
  picker: {
    pick: isFunction,
    drillPick: isFunction,
    pickPosition: isFunction,
    pickPositionSupported: isBoolean,
    pickGlobe: isFunction,
  },
  projector: {
    worldToWindow: isFunction,
    viewProjection: isFunction,
    horizonVisible: isFunction,
  },
  frames: {
    preUpdate: isEngineEvent,
    preRender: isEngineEvent,
    postRender: isEngineEvent,
  },
  render: {
    request: isFunction,
    setContinuous: isFunction,
    isContinuous: isFunction,
    setSharpen: isFunction,
    sharpen: isFunction,
  },
  surface: {
    sampleHeight: isFunction,
    sampleHeightDetailed: isFunction,
    supported: isBoolean,
    terrainHeight: isFunction,
    terrainHeightSupported: isBoolean,
    clampToHeight: isFunction,
    clampToHeightSupported: isBoolean,
    tilesLoaded: isFunction,
  },
  input: { on: isFunction, setCameraInputs: isFunction },
  credits: { addStatic: isFunction },
  clock: { now: isFunction, frameTime: isFunction, ticked: isEngineEvent },
  movers: { createSet: isFunction, list: isFunction },
  lines: { createLine: isFunction, list: isFunction },
  maps: {
    setBaseImagery: isFunction,
    setTerrain: isFunction,
    setPhotorealTiles: isFunction,
    releasePhotorealTiles: isFunction,
    photorealActive: isFunction,
    current: isFunction,
  },
};

/** The capability paths the contract requires, e.g. 'camera.flyTo'. */
export const GLOBE_ENGINE_MEMBERS = Object.freeze([
  'kind',
  ...Object.entries(SHAPE).flatMap(([capability, members]) =>
    Object.keys(members).map((member) => `${capability}.${member}`),
  ),
  'destroy',
  'isDestroyed',
]);

/**
 * Whether a value is a globe engine rather than, say, a Cesium viewer (a
 * cheap structural test; assertGlobeEngine checks every member).
 */
export const isGlobeEngine = (value) =>
  isObject(value) &&
  ENGINE_KINDS.includes(value.kind) &&
  isObject(value.camera) &&
  isObject(value.projector) &&
  isObject(value.frames) &&
  isFunction(value.destroy);

/** Throws a TypeError naming every missing or mistyped member; returns the engine. */
export function assertGlobeEngine(engine) {
  if (!isObject(engine)) throw new TypeError('GlobeEngine must be an object');
  const problems = [];
  if (!ENGINE_KINDS.includes(engine.kind)) problems.push('kind');
  for (const [capability, members] of Object.entries(SHAPE)) {
    const value = engine[capability];
    if (!isObject(value)) {
      problems.push(capability);
      continue;
    }
    for (const [member, valid] of Object.entries(members))
      if (!valid(value[member])) problems.push(`${capability}.${member}`);
  }
  if (!isFunction(engine.destroy)) problems.push('destroy');
  if (!isFunction(engine.isDestroyed)) problems.push('isDestroyed');
  if (problems.length)
    throw new TypeError(
      `GlobeEngine is missing or mistypes: ${problems.join(', ')}`,
    );
  return engine;
}

/** The sharpening an engine starts with (GlobeRender.sharpen). */
export const SHARPEN_INITIAL = Object.freeze({ enabled: false, amount: 1 });

/**
 * GlobeRender.setSharpen's argument merged onto `current`: a new state, or a
 * TypeError for a non-boolean `enabled` or a negative or non-finite `amount`.
 */
export function mergeSharpen(current, { enabled, amount } = {}) {
  if (enabled !== undefined && !isBoolean(enabled))
    throw new TypeError(`Sharpen enabled must be a boolean: ${enabled}`);
  if (amount !== undefined && !(isNumber(amount) && amount >= 0))
    throw new TypeError(
      `Sharpen amount must be a finite number >= 0: ${amount}`,
    );
  return {
    enabled: enabled ?? current.enabled,
    amount: amount ?? current.amount,
  };
}

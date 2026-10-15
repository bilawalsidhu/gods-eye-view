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
 * @property {number} percentageChanged
 *
 * @typedef {'click'|'doubleClick'|'move'|'down'|'up'} InputType
 * @typedef {'ctrl'|'shift'|'alt'} InputModifier
 * @typedef {{ position?: Cartesian2, startPosition?: Cartesian2, endPosition?: Cartesian2 }} InputEvent
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
 * @property {boolean} supported Whether sampleHeight works.
 * @property {(cartographic: Cartographic) => (number | undefined)} terrainHeight
 *   Height of the terrain/globe surface only (Cesium's globe.getHeight).
 * @property {boolean} terrainHeightSupported
 * @property {(position: Cartesian3, exclude?: any[]) => (Cartesian3 | undefined)} clampToHeight
 *   The position moved onto the rendered scene along the geodetic normal.
 * @property {boolean} clampToHeightSupported
 * @property {() => boolean} tilesLoaded
 *
 * @typedef {object} GlobeRender
 * @property {(reason?: string) => void} request Renders a frame soon in
 *   request mode; `reason` is for diagnostics only.
 * @property {(enabled: boolean) => void} setContinuous
 *   Owns whatever the engine needs to render every frame or only on request
 *   (Cesium: requestRenderMode and maximumRenderTimeChange = Infinity).
 * @property {() => boolean} isContinuous
 *
 * @typedef {object} PickResult
 * @property {any} id The picked entity or object id; undefined for map tiles.
 * @property {any} primitive
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
 * @typedef {object} GlobeEngine
 * @property {'cesium'|'navara'} kind
 * @property {{ container: object, canvas: object, size: () => { width: number, height: number } }} host
 * @property {GlobeCamera} camera
 * @property {{ pick: (screen: Cartesian2, width?: number, height?: number) => (PickResult | undefined), drillPick: (screen: Cartesian2, limit?: number, width?: number, height?: number) => PickResult[], pickPosition: (screen: Cartesian2) => (Cartesian3 | undefined), pickPositionSupported: boolean }} picker
 * @property {GlobeProjector} projector
 * @property {{ preUpdate: EngineEvent, preRender: EngineEvent, postRender: EngineEvent }} frames Listeners receive a timestamp in ms.
 * @property {GlobeRender} render
 * @property {GlobeSurface} surface
 * @property {{ on: (type: InputType, listener: (event: InputEvent) => void, options?: { modifier?: InputModifier }) => () => void, setCameraInputs: (enabled: boolean) => void }} input
 *   As in Cesium, a listener with a modifier fires only while that key is
 *   held and one without fires only while no modifier is held.
 * @property {{ addStatic: (html: string, options?: { onScreen?: boolean }) => () => void }} credits
 * @property {GlobeMaps} maps
 * @property {() => void} destroy
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
    percentageChanged: isNumber,
  },
  picker: {
    pick: isFunction,
    drillPick: isFunction,
    pickPosition: isFunction,
    pickPositionSupported: isBoolean,
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
  },
  surface: {
    sampleHeight: isFunction,
    supported: isBoolean,
    terrainHeight: isFunction,
    terrainHeightSupported: isBoolean,
    clampToHeight: isFunction,
    clampToHeightSupported: isBoolean,
    tilesLoaded: isFunction,
  },
  input: { on: isFunction, setCameraInputs: isFunction },
  credits: { addStatic: isFunction },
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
  if (problems.length)
    throw new TypeError(
      `GlobeEngine is missing or mistypes: ${problems.join(', ')}`,
    );
  return engine;
}

// The engine-neutral globe contract. The application shell talks to a globe
// engine (Cesium today, Navara next) only through these small capability
// objects. Positions are src/geo values, angles are radians and screen
// coordinates are CSS pixels from the canvas's top-left corner. This module
// and src/globe/testing/** never import cesium, three or @navaramap/*; see
// docs/CODE-BOUNDARIES.md.

/**
 * @typedef {{ x: number, y: number }} Cartesian2
 * @typedef {{ x: number, y: number, z: number }} Cartesian3
 * @typedef {{ longitude: number, latitude: number, height: number }} Cartographic
 * @typedef {(...args: any[]) => void} Listener
 *
 * @typedef {object} EngineEvent
 * @property {(listener: Listener) => () => void} addEventListener
 *   Returns a function that removes this registration (idempotent).
 * @property {(listener: Listener) => boolean} removeEventListener
 *
 * @typedef {object} CameraPose
 * @property {Cartesian3} position
 * @property {Cartographic} cartographic
 * @property {number} heading
 * @property {number} pitch
 * @property {number} roll
 * @property {Cartesian3} direction
 * @property {Cartesian3} up
 * @property {Cartesian3} right
 * @property {number} fovy Vertical field of view.
 *
 * @typedef {{ heading: number, pitch: number, roll: number }
 *   | { direction: Cartesian3, up: Cartesian3 }} Orientation
 *
 * @typedef {object} FlightOptions
 * @property {Cartesian3} destination
 * @property {Orientation} [orientation]
 * @property {number} [duration] Seconds; 0 lands on the next frame.
 * @property {'cubicInOut'|'sinusoidalInOut'|'linear'} [easing]
 * @property {() => void} [complete]
 * @property {() => void} [cancel] Called by cancelFlight or a newer flight.
 *
 * @typedef {object} GlobeCamera
 * @property {() => CameraPose} pose Fresh values on every call.
 * @property {(view: { destination: Cartesian3, orientation?: Orientation }) => void} setView
 * @property {(options: FlightOptions) => void} flyTo
 * @property {(sphere: { center: Cartesian3, radius: number }, options?: { heading?: number, pitch?: number, range?: number, duration?: number, complete?: () => void, cancel?: () => void }) => void} flyToSphere
 * @property {(target: Cartesian3, offset: { heading: number, pitch: number, range: number }) => void} lookAt
 * @property {() => void} release Leaves lookAt (Cesium's lookAtTransform(IDENTITY)).
 * @property {() => void} cancelFlight
 * @property {() => ({ west: number, south: number, east: number, north: number } | undefined)} viewRectangle
 * @property {(screen: Cartesian2) => (Cartesian3 | undefined)} pickEllipsoid
 * @property {(screen: Cartesian2) => { origin: Cartesian3, direction: Cartesian3 }} pickRay
 * @property {EngineEvent} changed Listener receives the change fraction.
 * @property {EngineEvent} moveStart
 * @property {EngineEvent} moveEnd
 * @property {number} percentageChanged
 *
 * @typedef {'click'|'doubleClick'|'move'|'down'|'up'} InputType
 * @typedef {{ position?: Cartesian2, startPosition?: Cartesian2, endPosition?: Cartesian2 }} InputEvent
 *
 * @typedef {object} GlobeEngine
 * @property {'cesium'|'navara'} kind
 * @property {{ container: object, canvas: object, size: () => { width: number, height: number } }} host
 * @property {GlobeCamera} camera
 * @property {{ pick: (screen: Cartesian2, width?: number, height?: number) => ({ id: any, primitive: any } | undefined), drillPick: (screen: Cartesian2, limit?: number) => any[], pickPosition: (screen: Cartesian2) => (Cartesian3 | undefined), pickPositionSupported: boolean }} picker
 * @property {{ worldToWindow: (position: Cartesian3, result?: Cartesian2) => (Cartesian2 | undefined) }} projector
 * @property {{ preUpdate: EngineEvent, preRender: EngineEvent, postRender: EngineEvent }} frames Listeners receive a timestamp in ms.
 * @property {{ request: () => void, setContinuous: (enabled: boolean) => void, isContinuous: () => boolean }} render
 * @property {{ sampleHeight: (cartographic: Cartographic, exclude?: any[]) => (number | undefined), supported: boolean, tilesLoaded: () => boolean }} surface
 * @property {{ on: (type: InputType, listener: (event: InputEvent) => void) => () => void, setCameraInputs: (enabled: boolean) => void }} input
 * @property {{ addStatic: (html: string, options?: { onScreen?: boolean }) => () => void }} credits
 * @property {{ setBaseImagery: (source: object) => void, setTerrain: (source: object) => void, setPhotorealTiles: (source: object | null) => void, photorealActive: () => boolean }} maps
 *   Sources are maps/registry.js descriptions; the engine builds its own providers.
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
export const FLIGHT_EASINGS = Object.freeze([
  'cubicInOut',
  'sinusoidalInOut',
  'linear',
]);

/**
 * An event with Cesium.Event semantics: listeners run in registration order,
 * removal during dispatch is deferred safely, and listeners added during
 * dispatch run from the next raise. `raiseEvent` is for engine implementations.
 */
export function createEngineEvent() {
  let entries = [];
  let depth = 0;
  let removedDuringRaise = false;
  const compact = () => {
    if (depth || !removedDuringRaise) return;
    entries = entries.filter((entry) => entry.listener);
    removedDuringRaise = false;
  };
  const removeEntry = (entry) => {
    if (!entry.listener) return false;
    entry.listener = null;
    if (depth) removedDuringRaise = true;
    else entries.splice(entries.indexOf(entry), 1);
    return true;
  };
  return {
    get numberOfListeners() {
      return entries.reduce(
        (count, entry) => count + (entry.listener ? 1 : 0),
        0,
      );
    },
    addEventListener(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('Engine event listener must be a function');
      const entry = { listener };
      entries.push(entry);
      return () => {
        removeEntry(entry);
      };
    },
    removeEventListener(listener) {
      const entry = entries.find(
        (candidate) => candidate.listener === listener,
      );
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
        depth--;
        compact();
      }
    },
  };
}

const isFunction = (value) => typeof value === 'function';
const isObject = (value) =>
  value != null && (typeof value === 'object' || typeof value === 'function');
const isEvent = (value) =>
  isObject(value) &&
  isFunction(value.addEventListener) &&
  isFunction(value.removeEventListener);
const isBoolean = (value) => typeof value === 'boolean';
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Capability → member → predicate. Members not listed here are free extensions.
const SHAPE = {
  host: { container: isObject, canvas: isObject, size: isFunction },
  camera: {
    pose: isFunction,
    setView: isFunction,
    flyTo: isFunction,
    flyToSphere: isFunction,
    lookAt: isFunction,
    release: isFunction,
    cancelFlight: isFunction,
    viewRectangle: isFunction,
    pickEllipsoid: isFunction,
    pickRay: isFunction,
    changed: isEvent,
    moveStart: isEvent,
    moveEnd: isEvent,
    percentageChanged: isNumber,
  },
  picker: {
    pick: isFunction,
    drillPick: isFunction,
    pickPosition: isFunction,
    pickPositionSupported: isBoolean,
  },
  projector: { worldToWindow: isFunction },
  frames: { preUpdate: isEvent, preRender: isEvent, postRender: isEvent },
  render: {
    request: isFunction,
    setContinuous: isFunction,
    isContinuous: isFunction,
  },
  surface: {
    sampleHeight: isFunction,
    supported: isBoolean,
    tilesLoaded: isFunction,
  },
  input: { on: isFunction, setCameraInputs: isFunction },
  credits: { addStatic: isFunction },
  maps: {
    setBaseImagery: isFunction,
    setTerrain: isFunction,
    setPhotorealTiles: isFunction,
    photorealActive: isFunction,
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

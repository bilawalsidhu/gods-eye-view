/**
 * @module render/rendererOf
 * @description The renderer that draws a scene, found from the scene object
 * the code already holds. It bridges the migration: code that still holds
 * the scene reaches the renderer's ports through it, and the lookup goes
 * once that code is handed the renderer itself.
 */

const renderers = new WeakMap();

/**
 * Ports built for scene objects no renderer is bound to (a Cesium viewer
 * made directly, say), per port: each `{port, dispose}` kept for as long
 * as its scene object lives, or until a renderer is bound to it. The
 * renderer adapter provides the factory each is built with as it loads.
 */
function unboundPorts(member) {
  const built = new WeakMap();
  /** Ports superseded while their holder still used them (`keep`). */
  const keptPorts = new WeakMap();
  let build = null;
  return {
    provide(factory) {
      build = factory;
    },
    drop(host, port) {
      const entry = built.get(host);
      if (!entry || (port !== undefined && entry.port !== port)) {
        // A port a renderer superseded but its holder kept: its holder's to
        // let go of.
        const kept = port !== undefined && keptPorts.get(port);
        if (kept) {
          keptPorts.delete(port);
          kept.dispose();
        }
        return;
      }
      built.delete(host);
      entry.dispose();
    },
    /**
     * A renderer bound to `host` supersedes its built port: kept working
     * for whoever holds it when it says so (`keep`, an input port a
     * dispatcher listens on, let go of through `drop(host, port)`), else
     * released when it can be (it stops working for new callers but keeps
     * what it did), else disposed.
     */
    supersede(host) {
      const entry = built.get(host);
      if (!entry) return;
      built.delete(host);
      if (entry.keep) keptPorts.set(entry.port, entry);
      else if (entry.release) entry.release();
      else entry.dispose();
    },
    /** `options` reach `build` only when it is the call that builds. */
    find(host, options) {
      const port = rendererOf(host)?.[member];
      if (port) return port;
      if (!host || typeof host !== 'object') return null;
      if (host.isDestroyed?.()) {
        // Gone with its scene: let the built port go with it.
        this.drop(host);
        return null;
      }
      let entry = built.get(host);
      if (!entry && build) {
        entry = build(host, options);
        if (entry) built.set(host, entry);
      }
      return entry?.port ?? null;
    },
  };
}

const unboundCameras = unboundPorts('camera');
const unboundEffects = unboundPorts('effects');
const unboundGlobes = unboundPorts('globe');
/** Credits ports are `{port, dispose, release}`: see `bindRenderer`. */
const unboundCredits = unboundPorts('credits');
/** Draw ports are `{port, dispose, release}`, as credits ports are. */
const unboundDraws = unboundPorts('draw');
const unboundQueries = unboundPorts('query');
const unboundFrames = unboundPorts('frame');
const unboundInputs = unboundPorts('input');

/** What a click's raw engine picks are built with (`provideNativeClick`). */
let nativeClicks = null;

/**
 * Provide the factory `cameraOf` builds a camera port with for a scene
 * object no renderer is bound to. The renderer adapter provides it as it
 * loads; a later call replaces it.
 * @param {(host: object) => ({port: object, dispose: () => void} | null)} build
 */
export function provideUnboundCamera(build) {
  unboundCameras.provide(build);
}

/**
 * Provide the factory `findCredits` builds a credits port with for a scene
 * object no renderer is bound to, as `provideUnboundCamera` does. `release`
 * detaches a port a bound renderer supersedes, keeping its credits shown.
 * @param {(host: object) => ({port: object, dispose: () => void,
 *   release: () => void} | null)} build
 */
export function provideUnboundCredits(build) {
  unboundCredits.provide(build);
}

/**
 * Provide the factory `findDraw` builds a draw port with for a scene object
 * no renderer is bound to, as `provideUnboundCredits` does: a bound
 * renderer releases it, and the sets made through it keep drawing until
 * their owners dispose them.
 * @param {(host: object) => ({port: object, dispose: () => void,
 *   release: () => void} | null)} build
 */
export function provideUnboundDraw(build) {
  unboundDraws.provide(build);
}

/**
 * Provide the factory `findQuery` builds a query port with for a scene
 * object no renderer is bound to, as `provideUnboundCamera` does. It answers
 * over the sets drawn through `findDraw` on the same scene object.
 * @param {(host: object) => ({port: object, dispose: () => void} | null)} build
 */
export function provideUnboundQuery(build) {
  unboundQueries.provide(build);
}

/**
 * Provide the factory `findFrame` builds a frame port with for a scene
 * object no renderer is bound to, as `provideUnboundCamera` does.
 * @param {(host: object) => ({port: object, dispose: () => void} | null)} build
 */
export function provideUnboundFrame(build) {
  unboundFrames.provide(build);
}

/**
 * Provide the factory `findInput` builds an input port with for a scene
 * object no renderer is bound to, as `provideUnboundCamera` does. It is
 * given the `options` of the `findInput` call that builds, for test
 * doubles. A renderer bound later does not take the port from whoever
 * listens on it: it works until `releaseUnboundInput`.
 * @param {(host: object, options?: object) => ({port: object, dispose: () => void, keep?: boolean} | null)} build
 */
export function provideUnboundInput(build) {
  unboundInputs.provide(build);
}

/**
 * Provide what `nativeClickOf` builds a click's raw engine picks with. Not
 * part of the renderer contract: the renderer adapter provides it as it
 * loads, for what the app still draws outside the draw port and for code that
 * still reads the engine's own pick objects; a later call replaces it.
 * @param {(host: object, position: {x: number, y: number}) => (NativeClick | null)} build
 */
export function provideNativeClick(build) {
  nativeClicks = build;
}

/**
 * Provide the factory `findEffects` builds an effects port with for a
 * scene object no renderer is bound to, as `provideUnboundCamera` does.
 * @param {(host: object) => ({port: object, dispose: () => void} | null)} build
 */
export function provideUnboundEffects(build) {
  unboundEffects.provide(build);
}

/**
 * Provide the factory `findGlobe` builds a globe port with for a scene
 * object no renderer is bound to, as `provideUnboundCamera` does. A bound
 * renderer supersedes it with `release`, as credits are.
 * @param {(host: object) => ({port: object, dispose: () => void,
 *   release?: () => void} | null)} build
 */
export function provideUnboundGlobe(build) {
  unboundGlobes.provide(build);
}

/**
 * Let go of `port`, if it is the effects port `findEffects` built for
 * `host`: its passes go and the scene's own settings come back. A
 * renderer's own port, or one built later, is left alone.
 * @param {object|null|undefined} host
 * @param {object|null|undefined} port
 */
export function releaseUnboundEffects(host, port) {
  if (host && typeof host === 'object' && port) unboundEffects.drop(host, port);
}

/**
 * Bind a renderer to its scene object. A port `cameraOf` or `findEffects`
 * built for it while it had no renderer is disposed: its listeners hear
 * nothing more, and they answer with the renderer's ports from then on.
 * A credits port `findCredits` built is released, not disposed: the
 * credits added through it stay shown until their own Off. A globe port
 * `findGlobe` built is released too: its imagery stays drawn, following the
 * base, until its callers remove it. So is a draw port `findDraw` built: its
 * sets keep drawing until disposed.
 * @param {object} host The scene object callers hold.
 * @param {object} renderer
 * @returns {() => void} Unbinds, if the binding is still this one.
 */
export function bindRenderer(host, renderer) {
  if (renderers.has(host)) throw new Error('This scene already has a renderer');
  // The renderer's ports supersede ones built while there was none.
  unboundCameras.drop(host);
  unboundEffects.drop(host);
  unboundGlobes.supersede(host);
  unboundCredits.supersede(host);
  unboundDraws.supersede(host);
  unboundQueries.drop(host);
  unboundFrames.drop(host);
  unboundInputs.supersede(host);
  renderers.set(host, renderer);
  return () => {
    if (renderers.get(host) === renderer) renderers.delete(host);
  };
}

/**
 * The scene object the application holds for `renderer`: what every layer
 * and tool is handed, and reaches the renderer's ports through. It is the
 * application's own: the element the renderer
 * fills (`container`) and whether the scene is gone (`isDestroyed()`), and
 * nothing of the engine.
 * @param {object} renderer
 * @param {{container: HTMLElement}} options
 * @returns {{host: Readonly<{container: HTMLElement, isDestroyed: () => boolean}>,
 *   release: () => void}} `release` marks the scene gone and unbinds it.
 */
export function createSceneHost(renderer, { container }) {
  let destroyed = false;
  const host = Object.freeze({ container, isDestroyed: () => destroyed });
  const unbind = bindRenderer(host, renderer);
  return {
    host,
    release() {
      destroyed = true;
      unbind();
    },
  };
}

/**
 * @param {object|null|undefined} host
 * @returns {object|null} The renderer bound to `host`, or null.
 */
export const rendererOf = (host) => (host && renderers.get(host)) || null;

/**
 * The canvas the renderer bound to `host` draws in; with none bound, the
 * scene object's own `canvas` (a viewer's), the same element the default
 * renderer reports. For sizing by it and listening on it as DOM.
 * @param {object|null|undefined} host
 * @returns {HTMLCanvasElement|null}
 */
export const canvasOf = (host) =>
  rendererOf(host)?.canvas ?? host?.canvas ?? null;

/**
 * The camera port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives.
 * @param {object|null|undefined} host
 * @returns {import('./contract/camera').CameraPort | null} Null when `host`
 *   has no renderer and no camera can be built for it, or is destroyed.
 */
export function findCamera(host) {
  return unboundCameras.find(host);
}

/**
 * The effects port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives.
 * @param {object|null|undefined} host
 * @returns {import('./contract/effects').EffectsPort | null} Null when
 *   `host` has no renderer and no effects can be built for it, or is
 *   destroyed.
 */
export function findEffects(host) {
  return unboundEffects.find(host);
}

/**
 * The globe port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives, as `findCamera` does. Imagery added through a built port
 * stays drawn once a renderer is bound; the renderer's port lists only
 * its own.
 * @param {object|null|undefined} host
 * @returns {import('./contract/globe').GlobePort | null}
 */
export function findGlobe(host) {
  return unboundGlobes.find(host);
}

/**
 * The credits port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives, as `findCamera` does.
 * @param {object|null|undefined} host
 * @returns {import('./contract/credits').CreditsPort | null}
 */
export function findCredits(host) {
  return unboundCredits.find(host);
}

/**
 * The draw port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives, as `findCamera` does.
 *
 * This is how a layer that is handed the scene object (a viewer) draws:
 * it asks once, as it starts (`init`), and keeps the sets it makes; it
 * reaches the camera through `cameraOf` the same way. A layer whose
 * package is exported must tell a caller whose viewer has no renderer and
 * no adapter factory loaded that it cannot draw, rather than do nothing
 * (`drawOf`).
 *
 * A port built for a viewer with no renderer is released when a renderer
 * is bound to it later: the sets already made through it keep drawing
 * until disposed, but the renderer's own ports (its picks, height queries,
 * `whenSettled`) do not see them. Bind the renderer before anything draws.
 * @param {object|null|undefined} host
 * @returns {import('./contract/draw').DrawPort | null}
 */
export function findDraw(host) {
  return unboundDraws.find(host);
}

/** Why `host` has no port to `what` (draw with, query). */
const noPort = (host, what) =>
  new Error(
    host?.isDestroyed?.()
      ? 'This scene has been destroyed'
      : `This scene has no renderer to ${what}: bind one, or load the ` +
          "Cesium adapter's factories (the ./render/cesium/unbound export) for a viewer " +
          'with no renderer bound',
  );

/**
 * `findDraw`, for code that cannot start without one.
 * @param {object} host
 * @returns {import('./contract/draw').DrawPort}
 * @throws When there is no draw port for `host`.
 */
export function drawOf(host) {
  const draw = findDraw(host);
  if (draw) return draw;
  throw noPort(host, 'draw with');
}

/**
 * The query port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives, as `findCamera` does. A built one picks, and its height
 * queries see through, the sets drawn through `findDraw` on `host`; one
 * kept from before a renderer was bound answers as it did, while new
 * callers get the renderer's.
 * @param {object|null|undefined} host
 * @returns {import('./contract/query').QueryPort | null}
 */
export function findQuery(host) {
  return unboundQueries.find(host);
}

/**
 * `findQuery`, for code that cannot start without one.
 * @param {object} host
 * @returns {import('./contract/query').QueryPort}
 * @throws When there is no query port for `host`.
 */
export function queryOf(host) {
  const query = findQuery(host);
  if (query) return query;
  throw noPort(host, 'query');
}

/**
 * The frame port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives, as `findCamera` does. A built one listens to the loop
 * `host`'s owner runs, as they set it up. Bound later, a renderer's own
 * replaces it: its listeners hear nothing more and its holds end.
 * @param {object|null|undefined} host
 * @returns {import('./contract/frame').FramePort | null}
 */
export function findFrame(host) {
  return unboundFrames.find(host);
}

/**
 * `findFrame`, for code that cannot start without one.
 * @param {object} host
 * @returns {import('./contract/frame').FramePort}
 * @throws When there is no frame port for `host`.
 */
export function frameOf(host) {
  const frame = findFrame(host);
  if (frame) return frame;
  throw noPort(host, 'run frames with');
}

/**
 * The input port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives, as `findCamera` does. Bound later, a renderer's own
 * replaces it: its listeners hear nothing more.
 * @param {object|null|undefined} host
 * @param {object} [options] For the factory, when this call builds the
 *   port (test doubles: a fake event source, a clock).
 * @returns {import('./contract/input').InputPort | null}
 */
export function findInput(host, options) {
  return unboundInputs.find(host, options);
}

/**
 * Let go of `port`, if it is the input port `findInput` built for `host`
 * (even one a renderer bound since superseded): its listeners hear nothing
 * more. A renderer's own port, or one built later, is left alone.
 * @param {object|null|undefined} host
 * @param {object|null|undefined} port
 */
export function releaseUnboundInput(host, port) {
  if (host && typeof host === 'object' && port) unboundInputs.drop(host, port);
}

/**
 * A click's raw engine picks, built by the adapter's `provideNativeClick`.
 * @typedef {object} NativeClick
 * @property {{pick: unknown, pickWindow: (width: number, height: number) => unknown,
 *   drill: (limit?: number, width?: number, height?: number) => unknown[]}} native
 *   The engine's own picks at the click, each made at most once, for code
 *   still bound to the engine.
 * @property {(limit?: number, width?: number, height?: number) => import('./contract/query').Hit[]} drillHits
 *   `native.drill` read as hits: draw-set items as the query port gives
 *   them, the map as surface hits, and anything else as a hit with no set
 *   (its id null when it has none). For a touch's contact search, which
 *   stops at whatever is drawn over a contact.
 * @property {(width?: number, height?: number) => ({id: string|null} | import('./contract/query').Hit | null)} foreign
 *   What is on top there as the engine sees it, read where the renderer's
 *   pick names nothing: something drawn outside the draw port by its id
 *   (null when it has none), a draw-set item the renderer's sets do not
 *   hold as its hit; null when the top is the map or nothing.
 */

/**
 * The raw engine picks of a click at `position` (CSS pixels, in the pick
 * buffer), from the factory the renderer adapter provided; null when there
 * is none, or it has nothing for `host`.
 * @param {object|null|undefined} host
 * @param {{x: number, y: number}} position
 * @returns {NativeClick | null}
 */
export function nativeClickOf(host, position) {
  if (!nativeClicks || !host || typeof host !== 'object') return null;
  if (host.isDestroyed?.()) return null;
  return nativeClicks(host, position) ?? null;
}

/**
 * `findCamera`, for code that needs the camera.
 * @param {object} host
 * @returns {import('./contract/camera').CameraPort}
 * @throws When there is no camera for `host`.
 */
export function cameraOf(host) {
  const camera = findCamera(host);
  if (camera) return camera;
  throw new Error(
    host?.isDestroyed?.()
      ? 'This scene has been destroyed'
      : 'This scene has no renderer camera',
  );
}

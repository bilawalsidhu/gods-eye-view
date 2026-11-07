/**
 * @module render/rendererOf
 * @description The renderer that draws a scene, found from the scene object
 * the code already holds. It bridges the migration: code that still holds
 * the scene reaches the renderer's ports through it, and the lookup goes
 * once that code is handed the renderer itself.
 */

const renderers = new WeakMap();

/**
 * Ports built for scene objects no renderer is bound to (a viewer of a
 * made directly, say), per port: each `{port, dispose}` kept for as long
 * as its scene object lives, or until a renderer is bound to it. The
 * renderer adapter provides the factory each is built with as it loads.
 */
function unboundPorts(member) {
  const built = new WeakMap();
  let build = null;
  return {
    provide(factory) {
      build = factory;
    },
    drop(host, port) {
      const entry = built.get(host);
      if (!entry || (port !== undefined && entry.port !== port)) return;
      built.delete(host);
      entry.dispose();
    },
    /**
     * A renderer bound to `host` supersedes its built port: released when
     * it can be (it stops working for new callers but keeps what it did),
     * else disposed.
     */
    supersede(host) {
      const entry = built.get(host);
      if (!entry) return;
      built.delete(host);
      if (entry.release) entry.release();
      else entry.dispose();
    },
    find(host) {
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
        entry = build(host);
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
  renderers.set(host, renderer);
  return () => {
    if (renderers.get(host) === renderer) renderers.delete(host);
  };
}

/**
 * @param {object|null|undefined} host
 * @returns {object|null} The renderer bound to `host`, or null.
 */
export const rendererOf = (host) => (host && renderers.get(host)) || null;

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

/**
 * `findDraw`, for code that cannot start without one.
 * @param {object} host
 * @returns {import('./contract/draw').DrawPort}
 * @throws When there is no draw port for `host`.
 */
export function drawOf(host) {
  const draw = findDraw(host);
  if (draw) return draw;
  throw new Error(
    host?.isDestroyed?.()
      ? 'This scene has been destroyed'
      : 'This scene has no renderer to draw with: bind one, or load the ' +
          "Cesium adapter's factories (the ./render/cesium/unbound export) for a viewer " +
          'with no renderer bound',
  );
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

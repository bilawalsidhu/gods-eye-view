/**
 * @module render/rendererOf
 * @description The renderer that draws a scene, found from the scene object
 * the code already holds. It bridges the migration: code that still holds
 * the scene reaches the renderer's ports through it, and the lookup goes
 * once that code is handed the renderer itself.
 */

const renderers = new WeakMap();

/**
 * Camera ports built for scene objects no renderer is bound to (a viewer of
 * a consumer's own, say), each `{port, dispose}` and kept for as long as its
 * scene object lives, or until a renderer is bound to it.
 */
const unboundCameras = new WeakMap();
let buildUnboundCamera = null;
/** Credits ports built likewise, each `{port, dispose, release}`. */
const unboundCredits = new WeakMap();
let buildUnboundCredits = null;

/**
 * Provide the factory `cameraOf` builds a camera port with for a scene
 * object no renderer is bound to. The renderer adapter provides it as it
 * loads; a later call replaces it.
 * @param {(host: object) => ({port: object, dispose: () => void} | null)} build
 */
export function provideUnboundCamera(build) {
  buildUnboundCamera = build;
}

/**
 * Provide the factory `findCredits` builds a credits port with for a scene
 * object no renderer is bound to, as `provideUnboundCamera` does. `release`
 * detaches a port a bound renderer supersedes, keeping its credits shown.
 * @param {(host: object) => ({port: object, dispose: () => void,
 *   release: () => void} | null)} build
 */
export function provideUnboundCredits(build) {
  buildUnboundCredits = build;
}

/**
 * Bind a renderer to its scene object. A camera `cameraOf` built for it
 * while it had no renderer is disposed: its listeners hear nothing more,
 * and `cameraOf` answers with the renderer's camera from then on.
 * @param {object} host The scene object callers hold.
 * @param {object} renderer
 * @returns {() => void} Unbinds, if the binding is still this one.
 */
export function bindRenderer(host, renderer) {
  if (renderers.has(host)) throw new Error('This scene already has a renderer');
  // The renderer's camera supersedes one built while there was none.
  unboundCameras.get(host)?.dispose();
  unboundCameras.delete(host);
  // Its credits port does too for credits added from now on; one built
  // before is released, not disposed: the credits added through it stay
  // shown until their own Off.
  unboundCredits.get(host)?.release?.();
  unboundCredits.delete(host);
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
  return (
    rendererOf(host)?.camera ??
    findUnbound(host, unboundCameras, buildUnboundCamera)
  );
}

/**
 * The credits port of the renderer bound to `host`; with no renderer bound,
 * one built over `host` by the provided factory and kept with it while
 * `host` lives, as `findCamera` does.
 * @param {object|null|undefined} host
 * @returns {import('./contract/credits').CreditsPort | null}
 */
export function findCredits(host) {
  return (
    rendererOf(host)?.credits ??
    findUnbound(host, unboundCredits, buildUnboundCredits)
  );
}

function findUnbound(host, built, build) {
  if (!host || typeof host !== 'object') return null;
  if (host.isDestroyed?.()) {
    // Gone with its scene: let the built port go with it.
    built.get(host)?.dispose();
    built.delete(host);
    return null;
  }
  let part = built.get(host);
  if (!part && build) {
    part = build(host);
    if (part) built.set(host, part);
  }
  return part?.port ?? null;
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

/**
 * WebGL2 boot probe for the mobile shell.
 *
 * On devices without WebGL2 the 3D globe cannot render. The boot path must
 * show the keyless-2D fallback message instead of leaving a black canvas, so
 * this probe runs before the viewer is created and its status drives which
 * branch boots.
 *
 * @module mobile/webglSupport
 */

/** Message shown when WebGL2 is unavailable and the keyless 2D view boots. */
export const WEBGL2_FALLBACK_MESSAGE =
  'This device does not support WebGL2, so the 3D globe is unavailable. Showing the keyless 2D view instead.';

/**
 * Probe an already-created WebGL2 context for the boot path.
 * @param {object|null|undefined} gl WebGL2 rendering context, or null when
 * context creation failed.
 * @returns {'ok'|'no-webgl2'} `'no-webgl2'` when the context is missing so the
 * caller boots the keyless-2D fallback instead of a black canvas.
 */
export function probeWebgl2Status(gl) {
  if (!gl) return 'no-webgl2';
  return 'ok';
}

/**
 * Try to create a WebGL2 context from a canvas without throwing.
 * @param {object|null|undefined} canvas Canvas with a `getContext` method.
 * @returns {object|null} The WebGL2 context, or null when unavailable.
 */
export function createWebgl2Context(canvas) {
  try {
    return canvas?.getContext?.('webgl2') ?? null;
  } catch {
    return null;
  }
}

/**
 * Render the keyless-2D fallback message into a container instead of leaving
 * a black canvas.
 * @param {{ textContent: string }} container Element hosting the globe.
 * @returns {string} The message rendered.
 */
export function showWebgl2Fallback(container) {
  if (!container) throw new TypeError('A fallback container is required');
  container.textContent = WEBGL2_FALLBACK_MESSAGE;
  return WEBGL2_FALLBACK_MESSAGE;
}

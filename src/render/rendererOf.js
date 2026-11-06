/**
 * @module render/rendererOf
 * @description The renderer that draws a scene, found from the scene object
 * the code already holds. It bridges the migration: code that still holds
 * the scene reaches the renderer's ports through it, and the lookup goes
 * once that code is handed the renderer itself.
 */

const renderers = new WeakMap();

/**
 * Bind a renderer to its scene object.
 * @param {object} host The scene object callers hold.
 * @param {object} renderer
 * @returns {() => void} Unbinds, if the binding is still this one.
 */
export function bindRenderer(host, renderer) {
  if (renderers.has(host)) throw new Error('This scene already has a renderer');
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

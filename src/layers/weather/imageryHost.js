import { msg } from '../../i18n/index.js';

/** Resolve the visible surface that can own weather imagery without scene mutation. */
export function resolveImageryHost({ viewer, tileset }) {
  if (viewer?.scene?.globe?.show === true)
    return { collection: viewer.imageryLayers, kind: 'globe' };
  if (tileset?.imageryLayers)
    return { collection: tileset.imageryLayers, kind: 'tileset' };
  return { collection: null, kind: 'none' };
}

// What the layer calls a surface: engine.imagery's surfaces as host kinds.
const HOST_KIND = { globe: 'globe', tiles: 'tileset', none: 'none' };

/** Where an engine drapes imagery (engine.imagery.surface()), as a host;
 * the surface itself identifies it. */
export function engineImageryHost(engine) {
  const surface = engine.imagery.surface();
  return { kind: HOST_KIND[surface] ?? 'none', collection: surface };
}

export const NO_IMAGERY_HOST = msg(
  'Hidden by this map source · choose a globe map',
);

/** Report imagery suspension without changing or detaching the resolved host. */
export function imageryHostStatus(host) {
  return host.kind === 'none' ? NO_IMAGERY_HOST : null;
}

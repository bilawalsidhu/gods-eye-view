import { CABLE_GLOBE_STACK_IDS } from './policy.js';

/**
 * The surface cable paths drape on for one map stack (a ground set's
 * `drape`). The photoreal stack renders Google 3D tiles with the globe
 * hidden, so the paths need only the 3D tiles there; every other known
 * stack (the Bing stacks, Esri, OSM, Sentinel-2) renders imagery on the
 * shown globe, so only the terrain. 'both' is the fallback for an unknown
 * stack: it draws on every surface. Cesium classifies a ground batch
 * against only the surface asked for, which halves its draw commands;
 * Navara drapes on whatever surface it draws.
 * @param {string|null|undefined} activeId MapStackController stack id.
 * @returns {'tiles'|'terrain'|'both'}
 */
export function cableDrapeForStack(activeId) {
  if (activeId === 'photoreal') return 'tiles';
  if (CABLE_GLOBE_STACK_IDS.has(activeId)) return 'terrain';
  return 'both';
}

/**
 * The surface from the engine's own state, for the start (the boot-time
 * stack change raises no event): photoreal tiles shown → 'tiles', else
 * 'terrain'; 'both' without an engine.
 * @param {import('../../globe/contract.js').GlobeEngine|null|undefined} engine
 * @returns {'tiles'|'terrain'|'both'}
 */
export function cableDrapeForEngine(engine) {
  if (typeof engine?.maps?.photorealActive !== 'function') return 'both';
  return engine.maps.photorealActive() ? 'tiles' : 'terrain';
}

import { findGlobe } from '../../render/rendererOf.js';
import { CABLE_GLOBE_STACK_IDS } from './policy.js';

/**
 * What cable ground lines drape on for one map stack. The photoreal stack
 * renders Google 3D tiles with the globe HIDDEN, so cable ground lines only
 * need to drape on the tiles there; every other known stack (the bing
 * stacks and osm) renders imagery on the shown globe, so only the terrain
 * applies.
 * Draping on just the active surface halves the ground lines' draw
 * commands. `both` is the safe fallback for an unknown stack — it renders
 * on every surface, exactly the shipped pre-optimization behavior.
 * @param {string|null|undefined} activeId MapStackController stack id.
 * @returns {'tiles'|'terrain'|'both'} The draw sets' `clampTo`.
 */

export function cableClassificationTypeForStack(activeId) {
  if (activeId === 'photoreal') return 'tiles';
  if (CABLE_GLOBE_STACK_IDS.has(activeId)) return 'terrain';
  return 'both';
}

/**
 * Derive the active surface from what the renderer draws. The boot-time
 * `setStack(..., { silent: true })` fires no 'gev:map-stack-changed' event,
 * so the initial surface is read the way the height-datum listeners do: the
 * photoreal regime is exactly "globe hidden".
 * @param {object|null|undefined} host The scene object the renderer is bound
 *   to (the viewer); `both` when it has none, or one that cannot say whether
 *   the globe is shown.
 * @returns {'tiles'|'terrain'|'both'}
 */

export function cableClassificationTypeForScene(host) {
  const visible = findGlobe(host)?.isGlobeVisible?.();
  if (typeof visible !== 'boolean') return 'both';
  return visible ? 'terrain' : 'tiles';
}

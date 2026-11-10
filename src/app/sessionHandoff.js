/**
 * @typedef {object} SessionHandoff
 * @property {Map<string, {enabled: boolean, durable: boolean | undefined, visit: boolean}>} layers
 * @property {string[]} cameraOwners
 * @property {object | null} selection
 * @property {import('../scenes/director.js').SceneDirector | null} director
 */

/** Capture session intentions before any outgoing scene owner is released.
 * @returns {SessionHandoff}
 */
export function createSessionHandoff(
  session,
  { addressLayerIds = null, visit = false } = {},
) {
  const listed = addressLayerIds ? new Set(addressLayerIds) : null;
  return {
    layers: new Map(
      [...session.manager.layers].map(([id]) => [
        id,
        {
          enabled: session.manager.isEffectivelyEnabled(id),
          durable: listed ? listed.has(id) : undefined,
          visit,
        },
      ]),
    ),
    cameraOwners: [...session.manager.layers]
      .filter(([, entry]) => entry.module.cameraOwner)
      .map(([id]) => id),
    selection: null,
    director: session.director,
  };
}

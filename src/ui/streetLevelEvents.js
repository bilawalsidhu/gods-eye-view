/**
 * Sent on the document when a street-level photo opens or the viewer moves on
 * to another image (a click on the map, OPEN, voice, a walk through the
 * photo). The detail carries its identity, position and request id, or
 * null as the request id for a viewer step. An explicit panel command can
 * reannounce the accepted photo with `explicit: true`. Data Layers OPEN
 * signals whether it still owns the reveal with `revealFromOpen`.
 * The photo id is `<providerId>:<imageId>`.
 */
export const STREET_LEVEL_PHOTO_EVENT = 'gev:street-level-photo';

/**
 * Sent on the document when Street Level starts loading a photo, before its
 * STREET_LEVEL_PHOTO_EVENT. The request id in detail ties the later photo
 * to the selection at the start of that load.
 */
export const STREET_LEVEL_PHOTO_REQUEST_EVENT =
  'gev:street-level-photo-request';

/** The layer a street-level photo's card belongs to. */
export const STREET_LEVEL_LAYER = 'street-level';

export function announceStreetLevelPhoto(photo, options) {
  if (typeof CustomEvent === 'function')
    globalThis.document?.dispatchEvent?.(
      new CustomEvent(STREET_LEVEL_PHOTO_EVENT, {
        detail: { layerId: STREET_LEVEL_LAYER, ...photo, ...options },
      }),
    );
}

/** The card key of a street-level photo id. */
export const streetLevelCardKey = (id) =>
  id ? `${STREET_LEVEL_LAYER}:${id}` : '';

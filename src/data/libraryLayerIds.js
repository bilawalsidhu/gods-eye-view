/**
 * The Data Library's layer namespace, owned by the layer lifecycle: the
 * manager accepts a late registration only under `lib-<entry id>`, and the
 * library names its layers with the same rule.
 */

/** A library entry id: lowercase, digits and hyphens, 3–48 characters. */
export const LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/;
export const LIBRARY_LAYER_PREFIX = 'lib-';

/** The manager id a library entry's layer registers under. */
export function libraryLayerId(entryId) {
  return `${LIBRARY_LAYER_PREFIX}${entryId}`;
}

/** The entry id behind a library layer id, or null. */
export function libraryEntryIdOf(layerId) {
  if (typeof layerId !== 'string' || !layerId.startsWith(LIBRARY_LAYER_PREFIX))
    return null;
  const id = layerId.slice(LIBRARY_LAYER_PREFIX.length);
  return LIBRARY_ID_PATTERN.test(id) ? id : null;
}

/**
 * Who a camera's feed is from, kept with its dock or pin: the provider that
 * runs it and the owner a partner-supplied feed names (layers/cctv/controls.js
 * `cameraDetails`). Null when neither is known.
 * @param {{provider?: string|null, credit?: string|null}|null|undefined} details
 * @returns {{provider: string, credit: string}|null}
 */
export function cameraSource(details) {
  const words = (value) => (typeof value === 'string' && value.trim()) || '';
  const provider = words(details?.provider);
  const credit = words(details?.credit);
  return provider || credit ? { provider, credit } : null;
}

/**
 * The credit a camera's picture carries wherever it shows away from its card
 * (the dock, a pinned tile): its provider, then a partner feed's owner, as
 * the camera card's source line names them. The layer's current details win;
 * what was kept at docking or pinning covers a camera the layer no longer
 * holds (Cameras off).
 * @param {object|null|undefined} details The layer's `cameraDetails(id)`.
 * @param {object|null|undefined} [kept] The `{provider, credit}` kept with the dock or pin.
 * @returns {string} Empty when no source is known.
 */
export function cameraCredit(details, kept = null) {
  const source = cameraSource(details) || cameraSource(kept);
  return source
    ? [source.provider, source.credit].filter(Boolean).join(' · ')
    : '';
}

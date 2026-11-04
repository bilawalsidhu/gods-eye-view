/**
 * @module render/cesium/tileRequests
 * @description Admission hooks for an imagery provider's tile requests.
 *
 * A layer that rations its tiles (a request budget, readiness accounting,
 * dropping a frame that is no longer shown) states that policy as a hook
 * instead of replacing the provider's `requestImage`. The provider itself is
 * left untouched: the returned provider delegates everything to it through
 * its prototype and routes only tile requests, and optionally the credit,
 * through the hook.
 *
 * Fields Cesium writes onto a provider land on the returned one, so a
 * provider that reads such a field itself (a time-dynamic WMTS provider's
 * `_reload`) is not suited; the URL-template and raster providers that use
 * hooks today read none.
 */

/**
 * @typedef {object} TileRequest
 * @property {number} x
 * @property {number} y
 * @property {number} level
 * @property {object} [request] Cesium `Request`, when Cesium passed one.
 */

/**
 * @param {object} provider A Cesium imagery provider (or one built by Core).
 * @param {object} hooks
 * @param {(tile: TileRequest, issue: () => Promise<any>|undefined) => Promise<any>|undefined} [hooks.requestImage]
 *   Decides each request. `issue()` asks the provider; returning `undefined`
 *   defers the tile, and Cesium asks again on a later frame.
 * @param {() => object} [hooks.credit] The credit Cesium shows for the layer,
 *   read every frame, so it can change without restaging the imagery.
 * @returns {object} A provider to hand to `ImageryLayer`.
 */
export function withTileRequestHook(provider, { requestImage, credit } = {}) {
  const hooked = Object.create(provider);
  if (requestImage)
    hooked.requestImage = (x, y, level, request) =>
      requestImage({ x, y, level, request }, () =>
        provider.requestImage(x, y, level, request),
      );
  if (credit)
    Object.defineProperty(hooked, 'credit', {
      configurable: true,
      enumerable: true,
      get: credit,
    });
  return hooked;
}

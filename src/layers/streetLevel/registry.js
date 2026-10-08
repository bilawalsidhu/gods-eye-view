/**
 * The contract an imagery provider registers with the Street Level layer.
 *
 * @typedef {object} StreetLevelProvider
 * @property {string} id            Stable id, e.g. 'mapillary'; also the share-link option key.
 * @property {string} name          Human name for captions and legends, e.g. 'Mapillary'.
 * @property {string} label         Chip text and link label, e.g. 'MAPILLARY'.
 * @property {string|null} requiresKeyId  Key-setup id the provider needs, or null when keyless.
 * @property {string} pickPrefix    Every primitive id the provider creates starts with it.
 * @property {{coverage: string}} colors   The source's one colour, from policy.js PROVIDER_COLORS.
 * @property {{html: string}} credit   On-globe attribution while the provider is active.
 * @property {boolean} [groundClick]   No coverage to click: a click on the ground at street zoom opens its nearest image.
 * @property {string} [requiresMapStack]   Usable only on this map stack (Google Street View: 'photoreal', per Google's terms).
 * @property {boolean} [defaultOn]     Switched on until the user says otherwise (default true); match the share-link option default.
 * @property {(context: ProviderContext) => ProviderInstance} create
 *
 * @typedef {object} ProviderContext   Handed to `create()` once by the core.
 * @property {object} services         Scene services: picking, input, render, sprites, ground, terrain, scenePick (ground clicks need it).
 * @property {() => {pano: string, sinceMs: number|null}} getFilter   Filter resolved against now; read it on every use so "since N days" keeps up.
 * @property {() => boolean} isActive  Layer enabled and this provider switched on.
 * @property {() => 'draped'|'terrain'} getSurface   'terrain' on Google 3D at street zoom: draw on bare earth.
 * @property {GroundCaster|null} groundCaster   Bare-earth heights for terrain mode (groundCast.js); null without a terrain service.
 * @property {{meshAt: (lon: number, lat: number) => number|undefined, request: (points: Array<[number, number]>) => void, onSampled: (listener: (cells: Array<[number, number]>) => void) => () => void}|null} meshSampler   Sampled Google 3D surface heights (meshSampler.js); pass `meshAt` to `castLine`.
 * @property {() => void} notify       Ask the core to publish a new UI snapshot.
 * @property {{openImage: (imageId: string) => Promise<void>, reportError: (message: string|null) => void}} actions
 *
 * @typedef {object} ProviderInstance
 * @property {() => Promise<{configured: boolean}>} status
 * @property {(viewer: object) => void} init         Create collections, hidden.
 * @property {(viewer: object) => void} activate     Start drawing coverage for the camera.
 * @property {() => void} deactivate                 Detach, clear coverage and selection, hide.
 * @property {(viewer: object) => void} destroy
 * @property {() => void} refreshCoverage
 * @property {(filter: {pano: string, sinceMs: number|null}) => void} setFilter   The filter changed: redraw (reading `getFilter()`).
 * @property {(mode: 'draped'|'terrain') => void} [setSurface]   Redraw coverage and cones for the new surface mode.
 * @property {() => {count: number, zoom: number|null, kind: string|null, loading: boolean, hint: string, error: string|null, keyRequired: boolean}} coverageStats
 * @property {(pickId: string) => boolean} handlePick   The id carries the provider's own prefix.
 * @property {(sequenceId: string) => Promise<void>} [selectSequence]
 * @property {() => void} [clearSequence]
 * @property {() => {selectedId: string|null, images: number, loading: boolean}} [sequenceStats]
 * @property {(point: {lat: number, lon: number}, options?: {signal?: AbortSignal}) => Promise<string|null>} nearestImage   An aborted lookup gives up (it may reject with an AbortError).
 * @property {ViewerAdapter} viewer
 *
 * @typedef {object} GroundCaster
 * @property {(points: Array<[number, number]>, options?: {signal?: AbortSignal}) => Promise<boolean>} prepare   Fetch the heights around [lon, lat] points; true when all are known.
 * @property {(lines: Array<Array<[number, number]>>, options?: {signal?: AbortSignal}) => Promise<boolean>} prepareLines
 * @property {(lon: number, lat: number) => number|null} groundAt    Cached bare-earth ellipsoidal height.
 * @property {(coords: Array<[number, number]>) => Array<number>|null} castLine   Densified [lon, lat, height, ...] or null.
 *
 * @typedef {object} ViewerAdapter
 * @property {(host: HTMLElement) => Promise<void>} mount     Idempotent; may lazy-load a library.
 * @property {(imageId: string) => Promise<void>} open        Resolves once the image is on screen and a pose was emitted.
 * @property {() => void} close                               Drop the image, keep the instance warm.
 * @property {() => void} unmount                             Destroy the instance (host handed to another provider).
 * @property {() => void} resize
 * @property {(host: HTMLElement) => Promise<void>} [prewarm]
 * @property {(mode: 'letterbox'|'fill') => void} [setRenderMode]
 * @property {(listener: (pose: StreetPose) => void) => () => void} onPose
 *
 * @typedef {object} StreetPose
 * @property {string} providerId
 * @property {string} imageId
 * @property {{lon: number, lat: number}} position
 * @property {number|null} bearing
 * @property {number|null} tilt
 * @property {number|null} altitude
 * @property {boolean} isPano
 * @property {number|null} capturedAt   Epoch milliseconds.
 * @property {'day'|'month'} [capturedAtPrecision]   How exactly the provider dates images (default 'day').
 * @property {string|null} [title]     A place name for the caption, e.g. the address.
 * @property {string|null} creator
 * @property {string|null} sequenceId
 * @property {string} externalUrl      Deep link to the image on the provider's site.
 */

const REQUIRED = Object.freeze([
  'id',
  'name',
  'label',
  'pickPrefix',
  'colors',
  'credit',
  'create',
]);

const ID_GRAMMAR = /^[a-z][a-z0-9-]*$/;

/**
 * Validate providers and freeze their order, which is also the chip order.
 * @param {Array<StreetLevelProvider>} providers
 * @returns {ReadonlyArray<StreetLevelProvider>}
 */
export function validateProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0)
    throw new TypeError('Street Level needs at least one imagery provider');
  const ids = new Set();
  const prefixes = [];
  for (const provider of providers) {
    const label = provider?.id ?? '(unnamed)';
    for (const key of REQUIRED)
      if (provider?.[key] === undefined || provider?.[key] === null)
        throw new TypeError(`Street Level provider ${label} lacks ${key}`);
    if (typeof provider.id !== 'string' || !ID_GRAMMAR.test(provider.id))
      throw new TypeError(`Street Level provider id ${label} is not a slug`);
    if (ids.has(provider.id))
      throw new TypeError(`Duplicate Street Level provider ${provider.id}`);
    if (typeof provider.create !== 'function')
      throw new TypeError(
        `Street Level provider ${label}: create is not a function`,
      );
    if (typeof provider.pickPrefix !== 'string' || !provider.pickPrefix)
      throw new TypeError(`Street Level provider ${label} needs a pick prefix`);
    for (const other of prefixes)
      if (
        other.startsWith(provider.pickPrefix) ||
        provider.pickPrefix.startsWith(other)
      )
        throw new TypeError(
          `Street Level provider ${label}: pick prefix ${provider.pickPrefix} overlaps ${other}`,
        );
    if (!provider.credit?.html)
      throw new TypeError(`Street Level provider ${label} needs a credit`);
    if (
      typeof provider.colors?.coverage !== 'string' ||
      !provider.colors.coverage
    )
      throw new TypeError(
        `Street Level provider ${label} needs a coverage colour`,
      );
    ids.add(provider.id);
    prefixes.push(provider.pickPrefix);
  }
  return Object.freeze([...providers]);
}

/**
 * The key id every provider shares, or null if any is keyless or they differ
 * (then each chip reports its own need).
 * @param {ReadonlyArray<StreetLevelProvider>} providers
 * @returns {string|null}
 */
export function requiresKeyIdFor(providers) {
  const keys = new Set(providers.map((p) => p.requiresKeyId || null));
  if (keys.size !== 1) return null;
  return [...keys][0];
}

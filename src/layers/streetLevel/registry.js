/**
 * The contract an imagery provider registers with the Street Level layer.
 *
 * @typedef {object} StreetLevelProvider
 * @property {string} id            Stable id, e.g. 'mapillary'; also the share-link option key.
 * @property {string} name          Human name for captions and legends, e.g. 'Mapillary'.
 * @property {string} label         Chip text and link label, e.g. 'MAPILLARY'.
 * @property {string|null} requiresKeyId  Key-setup id the provider needs, or null when keyless.
 * @property {string} pickPrefix    Every primitive id the provider creates starts with it.
 * @property {{coverage: string, coverageOld?: string, pano?: string}} colors
 * @property {{key: string, html: string}} credit   On-globe attribution while the provider is active.
 * @property {{coverage: 'tiles'|'bbox'|'none', sequences: boolean, pano: boolean, capturedAt: boolean, creator: boolean, follow: boolean}} capabilities
 * @property {Array<{key: string, label: string, color: string}>} legend  Coverage colour key.
 * @property {(imageId: string) => string} externalUrl  Deep link to the image on the provider's site.
 * @property {(context: ProviderContext) => ProviderInstance} create
 *
 * @typedef {object} ProviderContext   Handed to `create()` once by the core.
 * @property {object} services         Scene services: picking, input, render, sprites, ground.
 * @property {() => object|null} getViewer   The Cesium viewer once the layer is initialised.
 * @property {() => {pano: string, sinceMs: number|null}} getFilter   The resolved imagery filter.
 * @property {() => boolean} isActive  Layer enabled and this provider switched on.
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
 * @property {(filter: {pano: string, sinceMs: number|null}) => void} setFilter
 * @property {() => {count: number, zoom: number|null, kind: string|null, loading: boolean, hint: string, error: string|null, keyRequired: boolean}} coverageStats
 * @property {(pickId: string) => boolean} handlePick   The id carries the provider's own prefix.
 * @property {(sequenceId: string) => Promise<void>} [selectSequence]
 * @property {() => void} [clearSequence]
 * @property {() => {selectedId: string|null, images: number, loading: boolean}} [sequenceStats]
 * @property {(point: {lat: number, lon: number}) => Promise<string|null>} nearestImage
 * @property {ViewerAdapter} viewer
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
 * @property {string|null} creator
 * @property {string|null} sequenceId
 * @property {string} externalUrl
 */

const REQUIRED = Object.freeze([
  'id',
  'name',
  'label',
  'pickPrefix',
  'colors',
  'credit',
  'capabilities',
  'legend',
  'externalUrl',
  'create',
]);

const ID_GRAMMAR = /^[a-z][a-z0-9-]*$/;

/**
 * Check a provider list once at construction and freeze its order, which is
 * also the chip order in the panel.
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
    if (typeof provider.externalUrl !== 'function')
      throw new TypeError(
        `Street Level provider ${label}: externalUrl is not a function`,
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
    if (!provider.credit?.key || !provider.credit?.html)
      throw new TypeError(`Street Level provider ${label} needs a credit`);
    if (!Array.isArray(provider.legend))
      throw new TypeError(
        `Street Level provider ${label}: legend is not a list`,
      );
    ids.add(provider.id);
    prefixes.push(provider.pickPrefix);
  }
  return Object.freeze([...providers]);
}

/**
 * The layer-level key requirement: the one key id every provider shares, or
 * null as soon as any provider is keyless or they differ. Per-provider needs
 * are then reported chip by chip instead of gating the whole layer.
 * @param {ReadonlyArray<StreetLevelProvider>} providers
 * @returns {string|null}
 */
export function requiresKeyIdFor(providers) {
  const keys = new Set(providers.map((p) => p.requiresKeyId || null));
  if (keys.size !== 1) return null;
  return [...keys][0];
}

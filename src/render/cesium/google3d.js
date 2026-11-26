/**
 * @module render/cesium/google3d
 * @description Google Photorealistic 3D Tiles for the Cesium renderer, by
 * the routes `selectMapStartupRoute` (`src/maps/startupRoute.js`) names.
 */
export { selectMapStartupRoute } from '../../maps/startupRoute.js';

const clean = (value) => String(value || '').trim();

const MIB = 1024 * 1024;

/**
 * The photorealistic tileset's memory budget for a device. Desktops keep
 * the cache Cesium's Google helper sets (1536 MiB, 1024 MiB over it while
 * tiles in view need it). Phones and tablets (touch only: a coarse pointer
 * and no fine one) and devices reporting 4 GB of memory or less get 384 MiB
 * and 128 MiB over: iOS Safari closes a tab at around 0.5 to 1.5 GB, and
 * the desktop cache grows past that as the view moves from city to city,
 * while a street-level view still draws at full detail within the smaller
 * one.
 *
 * @param {{touchOnly?: boolean, deviceMemory?: number}} [device]
 *   `deviceMemory` is `navigator.deviceMemory` in GB, where the browser
 *   reports it.
 * @returns {{cacheBytes: number, maximumCacheOverflowBytes: number}}
 */
export function photorealCacheBudget({ touchOnly = false, deviceMemory } = {}) {
  const lowMemory = Number.isFinite(deviceMemory) && deviceMemory <= 4;
  return touchOnly || lowMemory
    ? { cacheBytes: 384 * MIB, maximumCacheOverflowBytes: 128 * MIB }
    : { cacheBytes: 1536 * MIB, maximumCacheOverflowBytes: 1024 * MIB };
}

/**
 * What `photorealCacheBudget` reads of this browser: touch only as the
 * quality port's probe takes it, and the memory the browser reports.
 * @returns {{touchOnly: boolean, deviceMemory?: number}}
 */
export function browserMemoryClass() {
  const media = (query) => globalThis.matchMedia?.(query).matches === true;
  return {
    touchOnly: media('(pointer: coarse)') && !media('(any-pointer: fine)'),
    deviceMemory: globalThis.navigator?.deviceMemory,
  };
}

const browserBudget = () => photorealCacheBudget(browserMemoryClass());

/**
 * Load Google Photorealistic 3D Tiles through direct Google access when
 * configured, otherwise through Cesium ion's hosted Google asset. Direct
 * access uses a browser key, or else short-lived tokens from the app's
 * server (see googleTokens.js). If direct access fails and an ion token is
 * available, ion is the recovery path.
 *
 * Every route caches tiles within `photorealCacheBudget` for this device.
 *
 * @param {object} Cesium
 * @param {{googleApiKey?: string, cesiumToken?: string, googleTokens?: {token: Function}|null}} credentials
 * @param {{budget?: {cacheBytes: number, maximumCacheOverflowBytes: number}}} [options]
 *   `budget` defaults to this browser's; tests pass their own.
 * @returns {Promise<{tileset: object|null, route: 'google-direct'|'google-token'|'google-ion'|'osm', errors: Error[]}>}
 */
export async function loadPhotorealisticTileset(
  Cesium,
  { googleApiKey = '', cesiumToken = '', googleTokens = null } = {},
  { budget = browserBudget() } = {},
) {
  const googleKey = clean(googleApiKey);
  const ionToken = clean(cesiumToken);
  const errors = [];

  const attempts = [];
  if (googleKey)
    attempts.push({
      route: 'google-direct',
      create: () => createGoogleDirectTileset(Cesium, googleKey, { budget }),
    });
  else if (googleTokens)
    attempts.push({
      route: 'google-token',
      create: () => createGoogleTokenTileset(Cesium, googleTokens, { budget }),
    });
  if (ionToken)
    attempts.push({
      route: 'google-ion',
      create: () => createGoogleIonTileset(Cesium, ionToken, { budget }),
    });

  for (const attempt of attempts) {
    try {
      const tileset = await attempt.create();
      return { tileset, route: attempt.route, errors };
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return { tileset: null, route: 'osm', errors };
}

/** Pass credentials to the source instead of changing SDK-wide defaults. */
export function createGoogleDirectTileset(
  Cesium,
  key,
  { budget = browserBudget() } = {},
) {
  key = clean(key);
  if (!key) throw new Error('Google 3D requires an explicit browser key');
  // Tiles keep drawing their own texture while draped weather loads, and
  // clamped marks land on them, as on the token routes' tiles.
  return Cesium.createGooglePhotorealistic3DTileset(
    { key, onlyUsingWithGoogleGeocoder: true },
    { ...budget, asynchronouslyLoadImagery: true, enableCollision: true },
  );
}

/**
 * Google 3D with short-lived tokens instead of a key. Every tile request
 * carries the token as a header; a tile refused for an expired token gets
 * the renewed one and is tried once more.
 */
export async function createGoogleTokenTileset(
  Cesium,
  tokens,
  { budget = browserBudget() } = {},
) {
  const token = await tokens.token();
  if (!token) throw new Error('Google 3D tokens are not offered');
  const credit = Cesium.GoogleMaps.getDefaultCredit?.();
  const resource = new Cesium.Resource({
    url: `${Cesium.GoogleMaps.mapTilesApiEndpoint}v1/3dtiles/root.json`,
    headers: { Authorization: `Bearer ${token}` },
    credits: credit ? [credit] : undefined,
    retryAttempts: 1,
    async retryCallback(failed, error) {
      if (![401, 403].includes(error?.statusCode)) return false;
      const used = failed.headers.Authorization?.replace(/^Bearer /, '');
      const renewed = await tokens.token({ replacing: used });
      if (!renewed || renewed === used) return false;
      failed.headers.Authorization = `Bearer ${renewed}`;
      return true;
    },
  });
  // The settings the key route gives Cesium's Google helper.
  return Cesium.Cesium3DTileset.fromUrl(resource, {
    ...budget,
    enableCollision: true,
    // Tiles keep drawing their own texture while draped weather loads.
    asynchronouslyLoadImagery: true,
  });
}

export async function createGoogleIonTileset(
  Cesium,
  accessToken,
  { signal, budget = browserBudget() } = {},
) {
  accessToken = clean(accessToken);
  if (!accessToken)
    throw new Error('Google 3D through ion requires an explicit token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(2275207, {
    accessToken,
  });
  signal?.throwIfAborted();
  // The settings the key route gives Cesium's Google helper.
  return Cesium.Cesium3DTileset.fromUrl(resource, {
    ...budget,
    enableCollision: true,
    // Tiles keep drawing their own texture while draped weather loads.
    asynchronouslyLoadImagery: true,
  });
}

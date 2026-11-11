import * as Cesium from 'cesium';
import { createTerrainRetryPolicy } from './terrainRetry.js';
import { KEYLESS_TERRAIN_URL } from './sourceSettings.js';

export { KEYLESS_TERRAIN_URL };

/** These factories are lazy: a hidden globe must not trigger terrain loading. */
export async function createWorldTerrain(accessToken, { signal } = {}) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken)
    throw new Error('World terrain requires an explicit ion token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(1, { accessToken });
  signal?.throwIfAborted();
  return {
    provider: await Cesium.CesiumTerrainProvider.fromUrl(resource, {
      requestVertexNormals: true,
      requestWaterMask: false,
      ellipsoid: Cesium.Ellipsoid.WGS84,
    }),
  };
}

function logThrottle({ statusCode, delayMs, inWindow }) {
  // One line per cooldown window, not per tile: a burst throttles dozens.
  if (inWindow !== 1) return;
  console.warn(
    `[MapStack] Re:Earth terrain answered ${statusCode}; retrying throttled tiles after ${Math.round(delayMs)} ms`,
  );
}

/**
 * The keyless terrain resource (Re:Earth unless GEV_TERRAIN_URL names
 * another) with the tile retry policy attached. Cesium copies
 * `retryCallback`/`retryAttempts` onto every derived resource, so layer.json
 * and each `{z}/{x}/{y}.terrain` fetch inherit it (see `terrainRetry.js`).
 * @param {ReturnType<typeof createTerrainRetryPolicy>} [policy]
 * @returns {Cesium.Resource}
 */
export function createKeylessTerrainResource(
  policy = createTerrainRetryPolicy({ onThrottle: logThrottle }),
  url = KEYLESS_TERRAIN_URL,
) {
  return new Cesium.Resource({
    url,
    retryCallback: policy.retryCallback,
    retryAttempts: policy.retryAttempts,
  });
}

/**
 * @param {string|null} [url] a parsed GEV_TERRAIN_URL: undefined for Re:Earth,
 *   null for the flat ellipsoid without any request
 */
export async function createKeylessTerrain(url) {
  if (url === null) return { provider: new Cesium.EllipsoidTerrainProvider() };
  try {
    return {
      provider: await Cesium.CesiumTerrainProvider.fromUrl(
        createKeylessTerrainResource(undefined, url),
      ),
    };
  } catch (error) {
    console.warn(
      '[MapStack] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:',
      error,
    );
    return { provider: new Cesium.EllipsoidTerrainProvider(), fallback: true };
  }
}

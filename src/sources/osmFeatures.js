/**
 * Browser client for `/api/osm/features`: one curated preset inside a box,
 * as a count or as features. The server writes and bounds the Overpass
 * query and answers only when an operator configured Overpass; this only
 * names the preset, box, mode and limit.
 * @module sources/osmFeatures
 */

/**
 * @param {{fetchImpl?: typeof fetch, endpoint?: string}} [options]
 * @returns {(request: {preset: string, bbox: number[], mode?: 'count'|'features', limit?: number}, options?: {signal?: AbortSignal}) => Promise<object>}
 */
export function createOsmFeatureSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/osm/features',
} = {}) {
  return async function searchOsmFeatures(
    { preset, bbox, mode = 'features', limit },
    { signal } = {},
  ) {
    const params = new URLSearchParams({
      preset,
      bbox: bbox.map((v) => Number(v).toFixed(5)).join(','),
      mode,
    });
    if (Number.isFinite(limit)) params.set('limit', String(limit));
    let response;
    try {
      response = await fetchImpl(`${endpoint}?${params}`, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        ok: false,
        status: 0,
        error: 'OpenStreetMap search is unreachable.',
      };
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        code: body?.code || null,
        error:
          body?.error || `OpenStreetMap search failed (${response.status}).`,
      };
    return { ok: true, ...body };
  };
}

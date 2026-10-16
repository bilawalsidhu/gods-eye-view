import {
  ALPHA_EARTH_ATTRIBUTION,
  ALPHA_EARTH_CREDIT,
  GRID_ENCODING,
} from './model.js';

/** A failed request, with the server's error code when it sent one. */
export class AlphaEarthSourceError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.name = 'AlphaEarthSourceError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES = Object.freeze({
  no_coverage: 'No embeddings cover this box for both years',
  rate_limited: 'Too many comparisons · wait a minute',
  busy: 'The server is busy with other comparisons · try again shortly',
  timeout: 'The comparison took too long · try a smaller box',
  upstream_failed: 'The embedding mirror did not answer',
  bad_request: 'The server refused this box',
});

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * AlphaEarth change acquisition through the local `/api/alpha-earth` proxy,
 * which reads the Source Cooperative mirror. Transport is replaceable.
 */
export function createAlphaEarthSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  baseUrl = '/api/alpha-earth',
} = {}) {
  async function get(path, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${baseUrl}${path}`, { signal });
    const body = await readJson(response);
    signal?.throwIfAborted();
    if (!response.ok) {
      const code = body?.error || 'upstream_failed';
      throw new AlphaEarthSourceError(
        code,
        MESSAGES[code] || body?.message || `HTTP ${response.status}`,
        response.status,
      );
    }
    if (!body) throw new AlphaEarthSourceError('bad_response', 'Empty reply');
    return body;
  }

  return {
    credit: ALPHA_EARTH_CREDIT,
    attribution: ALPHA_EARTH_ATTRIBUTION,

    /** @returns {Promise<number[]>} Published years, ascending. */
    async listYears({ signal } = {}) {
      const body = await get('/years', signal);
      return (Array.isArray(body.years) ? body.years : [])
        .map(Number)
        .filter(Number.isInteger)
        .sort((a, b) => a - b);
    },

    /**
     * The change grid between two years over a degrees box.
     * @param {{ box: object, from: number, to: number, detail?: 'standard'|'high', signal?: AbortSignal }} query
     */
    async fetchChange({ box, from, to, detail = 'standard', signal }) {
      const params = new URLSearchParams({
        west: String(box.west),
        south: String(box.south),
        east: String(box.east),
        north: String(box.north),
        from: String(from),
        to: String(to),
        detail,
      });
      const body = await get(`/change?${params}`, signal);
      if (
        body.encoding !== GRID_ENCODING ||
        !Number.isInteger(body.width) ||
        !Number.isInteger(body.height)
      )
        throw new AlphaEarthSourceError(
          'bad_response',
          'Unknown grid encoding',
        );
      return body;
    },
  };
}

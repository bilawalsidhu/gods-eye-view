import { isValidTileCoord as isValidTomTomTile } from '../../data/tomtomTiles.js';
import {
  projectNearbyPlaces,
  projectTextSearchPlaces,
} from '../../data/placeProviderPayloads.js';
import { endpointSet } from '../runtimeConfig.js';
import { isUpstreamRefusal } from '../sourcePolicy.js';
import { assertKeyedHttps } from '../governors.js';

/**
 * Keyed on-device metered traffic: TomTom flow tiles (vault key + daily
 * budget), Google Places direct (vault browser key, parity with the
 * `/api/google/*` dev-server flow — no token endpoint on-device), and the
 * HUD summary via a direct Responses call.
 *
 * - TomTom tiles mirror the server proxy's upstream
 *   (`traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf`, style `relative`).
 *   Every fetch spends from the injected daily budget first; an exhausted
 *   budget rejects with `BUDGET_EXHAUSTED` instead of burning allowance.
 * - Google Places mirrors the server's `searchNearby`/`searchText` bodies,
 *   headers (`X-Goog-Api-Key`, never a URL query), and field masks, with
 *   rows projected by the shared `projectNearbyPlaces` /
 *   `projectTextSearchPlaces`. Keyless resolves honest `{ places: [],
 *   unavailable: 'KEY_REQUIRED' }` — never a fake empty map.
 * - The HUD summary POSTs the Responses API directly with the vault
 *   `OPENAI_API_KEY`, using the same model, instructions, and five-word
 *   clamp as the server route. `HUD_SUMMARY_PROXY_PATH` links the Task-1
 *   `endpoints.summary` seam: Task 5 selects this proxy path when a backend
 *   is configured and the direct source otherwise.
 *
 * Keyed URLs must be HTTPS (`assertKeyedHttps`), refused before any
 * transport call; the caller signal is checked after every await so late
 * responses are discarded (no native abort exists).
 *
 * @module mobile/adapters/meteredDirect
 */

/** Rejection code when today's TomTom tile budget is spent. */
export const TOMTOM_BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED';

/** Default daily tile budget (200k/month free tier, headroom included). */
export const TOMTOM_DAILY_BUDGET_LIMIT = 6000;

/** TomTom flow-tile root (style `relative`, like the server proxy). */
export const TOMTOM_FLOW_TILE_ROOT =
  'https://api.tomtom.com/traffic/map/4/tile/flow/relative';

/** Google Places direct endpoints (same as the server proxy). */
export const GOOGLE_PLACES_NEARBY_URL =
  'https://places.googleapis.com/v1/places:searchNearby';
export const GOOGLE_PLACES_TEXT_URL =
  'https://places.googleapis.com/v1/places:searchText';

/** Google Places field mask (same as the server proxy). */
export const GOOGLE_PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
].join(',');

/** OpenAI Responses endpoint for the direct HUD summary call. */
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * HUD summary model (same default the server route uses). Overridable per
 * source; the device has no env to read.
 */
export const HUD_SUMMARY_DIRECT_MODEL = 'gpt-5-nano';

/**
 * Same-origin HUD-summary proxy path from the Task-1 `endpoints.summary`
 * seam. Task 5 selects this path when a backend is configured and
 * `createHudSummaryDirect` otherwise.
 */
export const HUD_SUMMARY_PROXY_PATH = endpointSet('').summary;

/**
 * Create the on-device TomTom flow-tile source.
 * @param {{ fetchImpl?: Function, getKey?: Function, budget?: { trySpend: Function }|null, tileRoot?: string }} options Transport, vault reader, daily budget, and tile-root override.
 * @returns {{ getFlowTile: Function }} Tile-byte reader.
 */
export function createTomtomDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getKey = null,
  budget = null,
  tileRoot = TOMTOM_FLOW_TILE_ROOT,
} = {}) {
  return {
    /**
     * Fetch one flow tile as bytes (Mapbox Vector Tile, layer
     * "Traffic flow"), spending one budget unit on success. The spend happens
     * AFTER the upstream answers OK, so failed requests never burn allowance.
     * @param {number} z Zoom level.
     * @param {number} x Tile column.
     * @param {number} y Tile row.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<Uint8Array>} Tile bytes.
     */
    async getFlowTile(z, x, y, { signal } = {}) {
      if (!isValidTomTomTile(z, x, y)) {
        throw new TypeError(`Invalid TomTom tile coordinate: ${z}/${x}/${y}`);
      }
      signal?.throwIfAborted();
      const key = typeof getKey === 'function' ? await getKey() : null;
      signal?.throwIfAborted();
      if (typeof key !== 'string' || !key) {
        throw Object.assign(
          new Error('TomTom tile needs TOMTOM_API_KEY on this device'),
          {
            keyRequired: true,
          },
        );
      }
      // Pre-admission: refuse without touching the upstream when the budget
      // is already spent (a spent budget must not burn quota proving it).
      // `remaining` is advisory (a lost race still hits `trySpend` below),
      // and budgets without a peek keep the fetch-then-spend fallback.
      if (
        budget &&
        typeof budget.remaining === 'function' &&
        (await budget.remaining()) <= 0
      ) {
        throw Object.assign(new Error("Today's TomTom tile budget is spent"), {
          code: TOMTOM_BUDGET_EXHAUSTED,
          unavailable: TOMTOM_BUDGET_EXHAUSTED,
        });
      }
      // TomTom flow tiles accept the API key only as a query parameter (no header
      // auth on this endpoint). The key is validated to HTTPS by assertKeyedHttps
      // before use. This is an accepted risk: the query string may appear in
      // server/proxy logs, browser history, or Referer headers. Prefer HTTPS and
      // rotate keys if the device is shared or lost.
      const url = `${tileRoot}/${z}/${x}/${y}.pbf?key=${encodeURIComponent(key)}`;
      assertKeyedHttps(url);
      const response = await fetchImpl(url, { signal });
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`TomTom tile HTTP ${response.status}`);
      if (
        budget &&
        typeof budget.trySpend === 'function' &&
        !(await budget.trySpend())
      ) {
        throw Object.assign(new Error("Today's TomTom tile budget is spent"), {
          code: TOMTOM_BUDGET_EXHAUSTED,
          unavailable: TOMTOM_BUDGET_EXHAUSTED,
        });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      return bytes;
    },
  };
}

/**
 * Read the vault Google key once (header-carried, never logged).
 * @param {Function|null} getKey Vault reader.
 * @returns {Promise<string|null>} Key, or null when keyless.
 */
async function readGoogleKey(getKey) {
  try {
    const key = typeof getKey === 'function' ? await getKey() : null;
    return typeof key === 'string' && key ? key : null;
  } catch {
    return null;
  }
}

/**
 * Create the on-device Google Places source (vault browser key directly).
 * @param {{ fetchImpl?: Function, getKey?: Function, nearbyUrl?: string, textUrl?: string }} options Transport, vault reader, and endpoint overrides.
 * @returns {{ searchNearby: Function, textSearch: Function }} Place readers.
 */
export function createGooglePlacesDirect({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getKey = null,
  nearbyUrl = GOOGLE_PLACES_NEARBY_URL,
  textUrl = GOOGLE_PLACES_TEXT_URL,
} = {}) {
  /**
   * POST one Places request with the key in the header (never the URL).
   */
  async function placesPost(url, body, key, signal) {
    assertKeyedHttps(url);
    const response = await fetchImpl(url, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new Error(`Google Places HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    signal?.throwIfAborted();
    return data;
  }

  return {
    /**
     * Nearby place labels around a point (same body as the server proxy).
     * @param {{ latitude: number, longitude: number, radiusM?: number, signal?: AbortSignal }} options Center, radius, caller signal.
     * @returns {Promise<{ places: object[], error: null }|{ places: never[], unavailable: string }>} Projected rows, or honest keyless unavailability.
     */
    async searchNearby({ latitude, longitude, radiusM = 250, signal } = {}) {
      if (
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180
      ) {
        throw new TypeError('Valid latitude/longitude are required');
      }
      signal?.throwIfAborted();
      const key = await readGoogleKey(getKey);
      signal?.throwIfAborted();
      if (!key) return { places: [], unavailable: 'KEY_REQUIRED' };
      try {
        const data = await placesPost(
          nearbyUrl,
          {
            maxResultCount: 20,
            rankPreference: 'DISTANCE',
            locationRestriction: {
              circle: {
                center: { latitude, longitude },
                radius: Math.max(25, Math.min(5000, Number(radiusM) || 250)),
              },
            },
          },
          key,
          signal,
        );
        return {
          places: projectNearbyPlaces(data, latitude, longitude),
          error: null,
        };
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return { places: [], unavailable: 'UPSTREAM_NOT_ALLOWED' };
        }
        throw error;
      }
    },
    /**
     * View-biased text search for a named place (same body as the proxy).
     * @param {{ query: string, latitude: number, longitude: number, radiusM?: number, signal?: AbortSignal }} options Query, view bias, caller signal.
     * @returns {Promise<{ places: object[], error: null }|{ places: never[], unavailable: string }>} Projected rows, or honest keyless unavailability.
     */
    async textSearch({
      query,
      latitude,
      longitude,
      radiusM = 4000,
      signal,
    } = {}) {
      const textQuery = String(query || '').trim();
      if (!textQuery) throw new TypeError('A text query is required');
      if (
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180
      ) {
        throw new TypeError('Valid latitude/longitude are required');
      }
      signal?.throwIfAborted();
      const key = await readGoogleKey(getKey);
      signal?.throwIfAborted();
      if (!key) return { places: [], unavailable: 'KEY_REQUIRED' };
      try {
        const data = await placesPost(
          textUrl,
          {
            textQuery,
            locationBias: {
              circle: {
                center: { latitude, longitude },
                radius: Math.max(50, Math.min(50000, Number(radiusM) || 4000)),
              },
            },
            maxResultCount: 5,
          },
          key,
          signal,
        );
        return {
          places: projectTextSearchPlaces(data, latitude, longitude),
          error: null,
        };
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return { places: [], unavailable: 'UPSTREAM_NOT_ALLOWED' };
        }
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// HUD summary (direct Responses call)
// ---------------------------------------------------------------------------

/**
 * HUD summary instructions (same lines the server route sends — ported, not
 * imported, because the server route module is Node-runtime).
 */
export const HUD_SUMMARY_DIRECT_INSTRUCTIONS = [
  "Write one concise intelligence-HUD summary for God's Eye View.",
  'Use only the supplied place, street, nearby-place, enabled-layer labels, and feedProvenance.',
  'Prefer the clearest named place and include a relevant enabled layer only when useful.',
  'If any enabled layer is not nominal, the five words MUST include that feedState token (STALE, DEGRADED, FALLBACK, LOADING, or UNAVAILABLE) and must not present the view as live.',
  'Do not infer from coordinates or invent a place or feed state.',
  'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
].join(' ');

/**
 * Extract response text from a Responses payload (same rule as the proxy).
 * @param {*} data Parsed Responses body.
 * @returns {string} Text, or ''.
 */
function extractResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

/**
 * Clamp text to the five-word HUD line (same rule as the proxy).
 * @param {*} value Candidate text.
 * @returns {string} Up to five words.
 */
function toFiveWordSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/**
 * Create the on-device HUD summary source (direct Responses call with the
 * vault `OPENAI_API_KEY`).
 * @param {{ fetchImpl?: Function, getKey?: Function, model?: string, responsesUrl?: string }} options Transport, vault reader, model, and endpoint override.
 * @returns {{ summarize: Function }} Summary reader.
 */
export function createHudSummaryDirect({
  fetchImpl = (...args) => globalThis.fetch(...args),
  getKey = null,
  model = HUD_SUMMARY_DIRECT_MODEL,
  responsesUrl = OPENAI_RESPONSES_URL,
} = {}) {
  return {
    /**
     * Summarize layer context into the five-word HUD line.
     * @param {object} context Layer context (same shape the proxy receives).
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<{ summary: string|null, error: null }|{ summary: null, configured: boolean, code: string }|{ summary: null, error: string }>} Summary, keyless notice, or honest failure.
     */
    async summarize(context = {}, { signal } = {}) {
      signal?.throwIfAborted();
      let key = null;
      try {
        key = typeof getKey === 'function' ? await getKey() : null;
      } catch {
        key = null;
      }
      signal?.throwIfAborted();
      if (typeof key !== 'string' || !key) {
        return {
          summary: null,
          configured: false,
          code: 'OPENAI_NOT_CONFIGURED',
        };
      }
      assertKeyedHttps(responsesUrl);
      let response;
      try {
        response = await fetchImpl(responsesUrl, {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            instructions: HUD_SUMMARY_DIRECT_INSTRUCTIONS,
            input: JSON.stringify(context ?? {}),
            reasoning: { effort: 'minimal' },
            max_output_tokens: 100,
          }),
        });
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return { summary: null, unavailable: 'UPSTREAM_NOT_ALLOWED' };
        }
        throw error;
      }
      signal?.throwIfAborted();
      const data = await response.json().catch(() => ({}));
      signal?.throwIfAborted();
      const summary = toFiveWordSummary(extractResponsesText(data));
      if (!response.ok || !summary) {
        return { summary: null, error: 'OpenAI HUD summary request failed' };
      }
      return { summary, error: null };
    },
  };
}

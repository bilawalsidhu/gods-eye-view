import { readResponseTextCapped } from '../common/http.js';
import {
  UPSTREAM_FM_BANDS,
  normalizeHamrigRepeaters,
} from '../../../src/sources/hamRepeaters.js';
import {
  HAMRIG_DEFAULT_BASE_URL,
  HAMRIG_DSTAR_MAX_LIMIT,
  HAMRIG_DSTAR_PATH,
  HAMRIG_FM_PATH,
  HAM_REPEATERS_MAX_BODY_BYTES,
  HAM_REPEATERS_TIMEOUT_MS,
  HAM_REPEATERS_USER_AGENT,
} from './constants.js';

/**
 * The HamRig adapter: two public routes on hamrig.com (an FM table and a
 * D-STAR table), read with the operator's `HAMRIG_BASE_URL` and normalised
 * into the provider-neutral row. It is the first of possibly several
 * adapters behind `/api/ham-repeaters/nearby`; a RepeaterBook or
 * OpenStreetMap adapter is a sibling module with the same `getRepeaters`.
 *
 * Not used, on purpose: HamRig's login-only `/api/repeaters/for-location`
 * (DL3EL's relaislisten.darc.de lists were granted to HamRig alone, per
 * locator, and not for third-party repeater maps). There is no code path for
 * it here, whatever HamRig credentials an operator has.
 */

const FALSE_WORDS = new Set(['0', 'false', 'no', 'off', 'disabled']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `origin + path` for an https base (http only for loopback), else null. */
export function normalizeHamrigBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function envFlag(value, fallback = true) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return fallback;
  return !FALSE_WORDS.has(text);
}

/** Operator configuration for the HamRig adapter. */
export function parseHamRepeatersEnv(env = process.env) {
  return {
    enabled: envFlag(env.HAMRIG_ENABLED, true),
    baseUrl:
      String(env.HAMRIG_BASE_URL ?? '').trim() || HAMRIG_DEFAULT_BASE_URL,
    fmEnabled: envFlag(env.HAM_REPEATERS_HAMRIG_FM, true),
  };
}

function shortMessage(error) {
  const text = String(error?.message ?? error ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || 'unknown error').slice(0, 200);
}

/** One bounded GET against HamRig; resolves for every HTTP status, throws on transport faults. */
export async function fetchHamrigJson(
  url,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = HAM_REPEATERS_TIMEOUT_MS,
    maxBytes = HAM_REPEATERS_MAX_BODY_BYTES,
    userAgent = HAM_REPEATERS_USER_AGENT,
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const timeout = new Error(
          `HamRig request timed out after ${timeoutMs} ms`,
        );
        timeout.code = 'HAMRIG_TIMEOUT';
        throw timeout;
      }
      const network = new Error(
        `HamRig request failed: ${shortMessage(error)}`,
      );
      network.code = 'HAMRIG_NETWORK';
      network.cause = error;
      throw network;
    }
    if (response.status >= 300 && response.status < 400) {
      try {
        await response.body?.cancel?.();
      } catch {
        /* no-op */
      }
      const redirect = new Error(
        'HamRig redirected; redirects are not followed',
      );
      redirect.code = 'HAMRIG_REDIRECT';
      throw redirect;
    }
    const text = await readResponseTextCapped(response, maxBytes);
    let json = null;
    const trimmed = String(text ?? '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        json = JSON.parse(trimmed);
      } catch {
        json = null;
      }
    }
    return { status: Number(response.status) || 0, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the HamRig adapter.
 * @returns {{ id: string, configured: boolean, baseUrl: string|null, sources: string[], getRepeaters: Function }}
 */
export function createHamrigRepeaterProvider({
  baseUrl = HAMRIG_DEFAULT_BASE_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
  fmEnabled = true,
  timeoutMs = HAM_REPEATERS_TIMEOUT_MS,
  log = console,
} = {}) {
  const base = normalizeHamrigBaseUrl(baseUrl);
  if (!base)
    log?.warn?.(
      `[ham-repeaters] HAMRIG_BASE_URL is not an https URL (${baseUrl}); the HamRig adapter will answer 502`,
    );
  const sources = [...(fmEnabled ? ['hamrig-fm'] : []), 'hamrig-dstar'];

  async function feed(path, query, label) {
    const url = `${base}${path}?${new URLSearchParams(query)}`;
    let result;
    try {
      result = await fetchHamrigJson(url, { fetchImpl, timeoutMs });
    } catch (error) {
      throw new Error(`HamRig ${label} failed: ${shortMessage(error)}`);
    }
    if (result.status < 200 || result.status >= 300)
      throw new Error(
        `HamRig ${label} returned HTTP ${result.status}${result.json?.error ? `: ${shortMessage(result.json.error)}` : ''}`,
      );
    if (!result.json || typeof result.json !== 'object')
      throw new Error(`HamRig ${label} returned no JSON`);
    if (result.json.success === false)
      throw new Error(
        `HamRig ${label} reported ${shortMessage(result.json.error ?? 'failure')}`,
      );
    return result.json;
  }

  return {
    id: 'hamrig',
    configured: Boolean(base),
    baseUrl: base,
    sources,
    /**
     * Repeaters around a point from the feeds the search asks for.
     * @returns {Promise<{ rows: object[], errors: Record<string,string>, sources: string[] }>}
     */
    async getRepeaters({
      lat,
      lon,
      radiusKm,
      limit,
      band = null,
      kind = 'all',
    }) {
      if (!base) throw new Error('HamRig adapter is not configured');
      const wantFm = fmEnabled && (kind === 'all' || kind === 'fm');
      const wantDstar = kind === 'all' || kind === 'dstar';
      const position = { lat: lat.toFixed(4), lng: lon.toFixed(4) };
      const radius = Math.round(radiusKm);
      const fmQuery = { ...position, radius, limit };
      if (band && UPSTREAM_FM_BANDS.includes(band)) fmQuery.band = band;
      const [fm, dstar] = await Promise.allSettled([
        wantFm
          ? feed(HAMRIG_FM_PATH, fmQuery, 'fm/repeaters/nearby')
          : Promise.resolve(null),
        wantDstar
          ? feed(
              HAMRIG_DSTAR_PATH,
              {
                ...position,
                radius,
                limit: Math.min(limit, HAMRIG_DSTAR_MAX_LIMIT),
              },
              'dstar/repeaters/nearby',
            )
          : Promise.resolve(null),
      ]);
      const errors = {};
      if (fm.status === 'rejected') errors.FM = shortMessage(fm.reason);
      if (dstar.status === 'rejected')
        errors['D-STAR'] = shortMessage(dstar.reason);
      const requested = (wantFm ? 1 : 0) + (wantDstar ? 1 : 0);
      if (requested > 0 && Object.keys(errors).length === requested)
        throw new Error(
          `Repeater feeds unavailable: ${Object.values(errors).join('; ')}`,
        );
      const rows = normalizeHamrigRepeaters(
        fm.status === 'fulfilled' ? fm.value : null,
        dstar.status === 'fulfilled' ? dstar.value : null,
      );
      const answered = [];
      if (wantFm && fm.status === 'fulfilled') answered.push('hamrig-fm');
      if (wantDstar && dstar.status === 'fulfilled')
        answered.push('hamrig-dstar');
      return { rows, errors, sources: answered };
    },
  };
}

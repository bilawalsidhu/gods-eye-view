import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { normalizeInatObservations } from '../../../src/layers/wildlifeSightings/records.js';
import { readResponseJsonCapped } from '../common/http.js';
import { clampInt } from '../common/query.js';
import { providerUserAgent } from '../common/userAgent.js';
import { projectInatGrid, validInatGridTile } from './grid.js';
import { createInatQueue } from './queue.js';

const DAILY_BUDGET = 8000;
const DAY_MS = 24 * 60 * 60_000;
// One page is capped independently of upstream Content-Length.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const API_URL = 'https://api.inaturalist.org/v1';
// Request only the fields used by the public observation projection.
const OBSERVATIONS_URL = 'https://api.inaturalist.org/v2/observations';
const OBSERVATION_FIELDS =
  '(id:!t,uri:!t,location:!t,geojson:all,geoprivacy:!t,taxon_geoprivacy:!t,' +
  'obscured:!t,quality_grade:!t,observed_on:!t,' +
  'time_observed_at:!t,faves_count:!t,' +
  'num_identification_agreements:!t,' +
  'photos:(url:!t,attribution:!t,license_code:!t),' +
  'taxon:(name:!t,preferred_common_name:!t,iconic_taxon_name:!t,' +
  'threatened:!t))';
const COOLDOWN_MS = 60_000;
const FAILURE_COOLDOWN_MS = 15_000;

/** Seconds and HTTP dates are accepted; a missing value earns one minute. */
export function inatRetryCooldownMs(raw, nowMs) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value) {
    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const deadline =
      !Number.isFinite(seconds) && /[a-z]/i.test(value)
        ? Date.parse(value)
        : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : deadline - nowMs;
    if (Number.isFinite(delay) && delay >= 0) return delay;
  }
  return COOLDOWN_MS;
}

function upstreamError(code, status, retryAfterS, upstreamStatus) {
  return Object.assign(new Error(code), {
    code,
    status,
    retryAfterS,
    upstreamStatus,
  });
}

function observationFilters(params) {
  const query = new URLSearchParams({
    verifiable: 'true',
    captive: 'false',
    // d1 is an observation DATE, unlike creation-time created_d1.
    d1: params.observedD1,
  });
  if (params.taxa !== 'whales') query.set('photos', 'true');
  if (params.quality === 'research') query.set('quality_grade', 'research');
  if (params.taxa === 'whales') query.set('taxon_id', '152871');
  else if (['Aves', 'Mammalia', 'Insecta', 'Plantae'].includes(params.taxa))
    query.set('iconic_taxa', params.taxa);
  return query;
}

/**
 * Shared iNaturalist governor. Only request counters are persisted; observation
 * payloads are projected immediately and are never written to disk.
 */
export function createInatClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'inaturalist'),
  warn = (...args) => console.warn(...args),
  queueOptions,
} = {}) {
  const enqueue = createInatQueue(queueOptions);
  let budget = null;
  let budgetLoaded = false;
  let budgetTail = Promise.resolve();
  let cooldownUntil = 0;
  // An unavailable UTFGrid tile must never place observation queries into a
  // 502 cooldown. Only an upstream 429 is a provider-wide restriction.
  const failures = new Map();

  function dailyLimit() {
    return clampInt(
      process.env.INATURALIST_DAILY_BUDGET,
      1,
      Number.MAX_SAFE_INTEGER,
      DAILY_BUDGET,
    );
  }

  function day() {
    return new Date(now()).toISOString().slice(0, 10);
  }

  function currentBudget() {
    const date = day();
    if (budget?.date !== date) budget = { date, count: 0 };
    return budget;
  }

  async function readBudgetOnce() {
    if (budgetLoaded) return;
    budgetLoaded = true;
    if (cacheDir === null) return;
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(cacheDir, 'budget.json'), 'utf8'),
      );
      if (
        typeof value?.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
        Number.isSafeInteger(value.count) &&
        value.count >= 0
      )
        budget = { date: value.date, count: value.count };
    } catch (error) {
      if (error.code !== 'ENOENT')
        warn('[inaturalist-proxy] budget read failed');
    }
  }

  async function persistBudget(value) {
    if (cacheDir === null) return;
    const destination = path.join(cacheDir, 'budget.json');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
      await fs.rename(temporary, destination);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      warn('[inaturalist-proxy] budget write failed');
    }
  }

  function retrySeconds(until = cooldownUntil) {
    return Math.max(0, Math.ceil((until - now()) / 1000));
  }

  function checkCooldown(resource) {
    if (now() < cooldownUntil)
      throw upstreamError('inaturalist_rate_limited', 429, retrySeconds(), 429);
    const failure = failures.get(resource);
    if (failure && now() < failure.until)
      throw upstreamError(
        'inaturalist_unavailable',
        502,
        retrySeconds(failure.until),
        failure.status,
      );
    failures.delete(resource);
  }

  // Reserve and atomically persist one attempt before issuing it. A recovered
  // tail prevents one disk/reservation failure from poisoning future calls.
  function reserveAttempt(signal, resource) {
    const result = budgetTail.then(async () => {
      signal?.throwIfAborted();
      checkCooldown(resource);
      await readBudgetOnce();
      signal?.throwIfAborted();
      checkCooldown(resource);
      const value = currentBudget();
      if (value.count >= dailyLimit()) {
        const retry = Math.max(
          1,
          Math.ceil((Date.parse(`${day()}T00:00:00Z`) + DAY_MS - now()) / 1000),
        );
        throw upstreamError('inaturalist_budget_exhausted', 503, retry);
      }
      value.count += 1;
      await persistBudget({ ...value });
    });
    budgetTail = result.catch(() => {});
    return result;
  }

  async function requestProjected(url, project, resource, { signal } = {}) {
    signal?.throwIfAborted();
    checkCooldown(resource);
    return enqueue(() => dispatch(url, project, resource, signal), {
      signal,
      priority: resource === 'observations' ? 0 : 1,
    });
  }

  async function dispatch(url, project, resource, signal) {
    signal?.throwIfAborted();
    await reserveAttempt(signal, resource);
    signal?.throwIfAborted();
    checkCooldown(resource);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let upstreamStatus;
    let retryDelay = FAILURE_COOLDOWN_MS;
    try {
      const response = await fetchImpl(url, {
        signal: requestSignal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': providerUserAgent('wildlife-sightings'),
        },
      });
      upstreamStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          const delay = inatRetryCooldownMs(
            response.headers.get('retry-after'),
            now(),
          );
          cooldownUntil = Math.max(cooldownUntil, now() + delay);
          throw upstreamError(
            'inaturalist_rate_limited',
            429,
            retrySeconds(),
            429,
          );
        }
        if (response.headers.has('retry-after'))
          retryDelay = inatRetryCooldownMs(
            response.headers.get('retry-after'),
            now(),
          );
        throw upstreamError('inaturalist_unavailable', 502);
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        requestSignal,
      );
      return project(payload);
    } catch (error) {
      // Log only safe diagnostic categories, never a URL, body, status text or
      // exception message (each can contain request/private information).
      const reason = signal?.aborted
        ? 'abort'
        : timeout.aborted || error.name === 'TimeoutError'
          ? 'timeout'
          : upstreamStatus && upstreamStatus >= 400
            ? 'http'
            : error.code === 'RESPONSE_TOO_LARGE'
              ? 'response-too-large'
              : upstreamStatus
                ? 'invalid-payload'
                : 'network';
      warn(
        `[inaturalist-proxy] upstream refresh failed resource=${resource} status=${upstreamStatus ?? 'none'} reason=${reason}`,
      );
      if (signal?.aborted) throw error;
      // Network, abort, schema and size failures are not upstream cooldown
      // signals. A later healthy request may recover immediately.
      if (upstreamStatus >= 500)
        failures.set(resource, {
          until: now() + retryDelay,
          status: upstreamStatus,
        });
      const failure = failures.get(resource);
      throw upstreamError(
        error.status === 429
          ? 'inaturalist_rate_limited'
          : 'inaturalist_unavailable',
        error.status === 429 ? 429 : 502,
        error.status === 429
          ? retrySeconds()
          : failure
            ? retrySeconds(failure.until)
            : undefined,
        upstreamStatus === 429 || upstreamStatus >= 500
          ? upstreamStatus
          : undefined,
      );
    }
  }

  /** Request one bounded observation sample and project its public fields. */
  async function getObservations(params, options = {}) {
    const query = observationFilters(params);
    // View samples stay stable in the route cache until their TTL expires.
    query.set('order_by', params.scope === 'view' ? 'random' : 'observed_on');
    if (params.scope !== 'view') query.set('order', 'desc');
    query.set('per_page', '200');
    query.set('fields', OBSERVATION_FIELDS);
    if (params.scope === 'view') {
      query.set('swlat', String(params.box.south));
      query.set('swlng', String(params.box.west));
      query.set('nelat', String(params.box.north));
      query.set('nelng', String(params.box.east));
    }
    return requestProjected(
      `${OBSERVATIONS_URL}?${query}`,
      (payload) => {
        if (
          !Array.isArray(payload?.results) ||
          !Number.isSafeInteger(payload.total_results) ||
          payload.total_results < 0
        )
          throw upstreamError('inaturalist_unavailable', 502);
        const rows = normalizeInatObservations(payload.results, {
          nowMs: now(),
          windowMs: (params.taxa === 'whales' ? 7 : 2) * DAY_MS,
        });
        // Empty views need total_results: 0. A wholly invalid page must not
        // replace good data. Valid rows excluded by the finer rolling-time
        // cutoff are a healthy empty result of the upstream DATE over-fetch.
        if (
          !rows ||
          (!rows.length &&
            (payload.results.length || payload.total_results) &&
            !normalizeInatObservations(payload.results)?.length)
        )
          throw upstreamError('inaturalist_unavailable', 502);
        return {
          rows,
          totalResults: payload.total_results,
          ...(payload.total_results > payload.results.length
            ? { partial: true, rawRowCount: payload.total_results }
            : {}),
        };
      },
      'observations',
      options,
    );
  }

  /** Decode one validated density tile without observation identifiers. */
  async function getGrid(params, options = {}) {
    if (!validInatGridTile(params)) throw new TypeError('Invalid grid tile');
    const query = observationFilters(params);
    return requestProjected(
      `${API_URL}/grid/${params.z}/${params.x}/${params.y}.grid.json?${query}`,
      (payload) => projectInatGrid(payload, params),
      'grid',
      options,
    );
  }

  return {
    getObservations,
    getGrid,
    /** Current provider-wide or resource-specific retry information. */
    cooldownState(resource) {
      if (now() < cooldownUntil)
        return {
          upstreamStatus: 429,
          retryAfterS: retrySeconds(),
        };
      const failure = failures.get(resource);
      if (failure && now() < failure.until)
        return {
          upstreamStatus: failure.status,
          retryAfterS: retrySeconds(failure.until),
        };
      return undefined;
    },
    /** The current UTC day's reserved upstream attempts and configured limit. */
    budgetState() {
      const value = currentBudget();
      return { ...value, budget: dailyLimit() };
    },
  };
}

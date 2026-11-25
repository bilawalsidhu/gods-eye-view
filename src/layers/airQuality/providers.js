import { msg } from '../../i18n/marker.js';
import { SA_POLLUTANTS } from './southAfrica.js';
import { interpretHourly } from './interpretation.js';
import { OPENAQ_POLLUTANTS } from './openAq.js';
import { CPCB_POLLUTANTS } from './cpcb.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { requestWithDeadline } from '../../sources/requestDeadline.js';
/** Maximum readings accepted in one snapshot before filtering by view. */
const MAX_SNAPSHOT_READINGS = 50_000;
/** `endpoint` with `fields` set in its query, keeping any query it has. */
function withQuery(endpoint, fields) {
  const at = endpoint.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : endpoint.slice(at + 1));
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return `${at < 0 ? endpoint : endpoint.slice(0, at)}?${params}`;
}

/**
 * Fixed-route snapshot adapter; caller supplies the acquisition endpoint.
 *
 * `getSnapshot` answers one pollutant (`parameter`), interpreted on the EEA
 * hourly bands when `hourly`, or with `mode: 'aqi'` every pollutant the
 * snapshot holds: the layer folds them into one reading per station. A
 * national snapshot is reused for `reuseMs` across views.
 * A snapshot holds at most 50,000 readings. Requests reject redirects.
 * Set keyed to false for a keyless route to report authorization failures as unavailable.
 * Account changes require a new source so cached answers and coverage belong to that account.
 */
export function createAirQualitySnapshotSource({
  endpoint,
  keyed = true,
  hourly = false,
  reuseMs = 0,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  let coverage = null;
  let reused = null;
  const malformed = () =>
    Object.assign(new Error(msg('Malformed air quality snapshot')), {
      code: 'malformed',
    });
  const failure = (code) =>
    Object.assign(new Error(msg('Air quality provider unavailable')), { code });
  async function fetchPayload(url, signal) {
    return requestWithDeadline(
      async (requestSignal) => {
        let response;
        try {
          response = await fetchImpl(url, {
            signal: requestSignal,
            redirect: 'error',
          });
        } catch {
          requestSignal.throwIfAborted();
          throw failure('unavailable');
        }
        if (!response.ok) {
          if (response.status === 429) {
            const body = await readResponseJsonCapped(
              response,
              8192,
              requestSignal,
            ).catch(() => null);
            requestSignal.throwIfAborted();
            throw Object.assign(
              new Error(
                msg(
                  'Provider request budget reached. Cached data will refresh later.',
                ),
              ),
              {
                code: 'rate_limited',
                retryAt: Number.isFinite(body?.retryAt)
                  ? body.retryAt
                  : now() + 60_000,
              },
            );
          }
          if (keyed && response.status === 403) {
            const body = await readResponseJsonCapped(
              response,
              8192,
              requestSignal,
            ).catch(() => null);
            requestSignal.throwIfAborted();
            if (body?.error === 'access_denied')
              throw Object.assign(
                new Error(
                  msg(
                    "The provider refused access for this key. Check the key's project, region or permissions.",
                  ),
                ),
                { code: 'access_denied' },
              );
          } else await response.body?.cancel().catch(() => {});
          if (keyed && (response.status === 401 || response.status === 403))
            throw Object.assign(
              new Error(msg('Provider key rejected. Check Provider Settings.')),
              { code: 'key_rejected' },
            );
          if (keyed && response.status === 428)
            throw Object.assign(new Error(msg('Provider API key required')), {
              code: 'no_key',
            });
          throw failure('unavailable');
        }
        let payload;
        try {
          payload = await readResponseJsonCapped(
            response,
            64 * 1024 * 1024,
            requestSignal,
          );
        } catch (error) {
          requestSignal.throwIfAborted();
          throw error?.code === 'RESPONSE_TOO_LARGE' ? error : malformed();
        }
        // A network this server leaves switched off: no failure, nothing to show.
        // English data for the console; the card shows no line for it.
        if (payload?.unavailable === true && payload.code === 'not_configured')
          throw Object.assign(new Error('Air quality provider not enabled'), {
            code: 'not_configured',
          });
        // A viewport answer carries counts in place of its station catalogue.
        if (
          payload?.schemaVersion !== 1 ||
          (payload.stations !== undefined &&
            !Array.isArray(payload.stations)) ||
          !Array.isArray(payload.readings)
        )
          throw malformed();
        if (payload.readings.length > MAX_SNAPSHOT_READINGS)
          throw Object.assign(new Error(msg('Upstream response too large')), {
            code: 'RESPONSE_TOO_LARGE',
          });
        return payload;
      },
      { signal, timeoutMs: 50_000 },
    );
  }
  return {
    getCoverage: () => coverage,
    async getSnapshot({ parameter = 'PM2.5', mode, signal, view } = {}) {
      const allPollutants = mode === 'aqi';
      signal?.throwIfAborted();
      const url = view
        ? withQuery(endpoint, {
            view: view.join(','),
            ...(allPollutants ? { mode: 'aqi' } : hourly ? { parameter } : {}),
          })
        : endpoint;
      // A national snapshot (no view) serves every view and pollutant: a
      // view switch within `reuseMs` filters the same payload again. One the
      // server marks stale is not kept, so a recovery shows on the next ask.
      const reusable = !view && reuseMs > 0;
      const payload =
        reusable && reused?.url === url && now() - reused.at < reuseMs
          ? reused.payload
          : await fetchPayload(url, signal);
      if (reusable && reused?.payload !== payload && payload.stale !== true)
        reused = { url, payload, at: now() };
      signal?.throwIfAborted();
      const readings = payload.readings
        .filter(
          (row) =>
            (allPollutants || row.parameter === parameter) &&
            Number.isFinite(row.observedMs) &&
            row.observedMs <= now() + 300_000 &&
            now() - row.observedMs <= 6 * 3600_000,
        )
        .map((row) => (hourly && !allPollutants ? interpretHourly(row) : row))
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        );
      const count = (v) => (Number.isFinite(v) ? v : undefined);
      coverage = {
        stale: payload.stale === true,
        partial: payload.partial === true,
        checked: count(payload.checked),
        eligible: count(payload.eligible),
        failureStatus: count(payload.failureStatus),
        retryAt: count(payload.retryAt),
      };
      return readings;
    },
  };
}

/**
 * Standalone-compatible defaults. Hosts can replace the entire provider list.
 *
 * Every provider is a station network, drawn together with the others in
 * one de-duplicated set; `direct: true` marks a network publishing its own
 * monitors, which wins over an aggregator's copy of the same site
 * (merge.js).
 */
export function createDefaultAirQualityProviders({ fetchImpl, now } = {}) {
  return [
    {
      id: 'saaqis',
      title: msg('South Africa'),
      label: msg('Air quality · South Africa'),
      network: 'SAAQIS',
      sourceLabel: 'SAAQIS · South Africa',
      direct: true,
      parameters: SA_POLLUTANTS,
      source: createAirQualitySnapshotSource({
        endpoint: '/api/air-quality/south-africa',
        keyed: false,
        hourly: true,
        // One layer refresh: a view switch does not ask again.
        reuseMs: 60_000,
        fetchImpl,
        now,
      }),
    },
    {
      id: 'cpcb',
      publishedTimes: true,
      title: msg('India'),
      label: msg('Air quality'),
      network: 'CPCB',
      sourceLabel: 'CPCB · data.gov.in',
      direct: true,
      parameters: CPCB_POLLUTANTS,
      requiresKeyId: 'data-gov-in',
      // The feed leaves its units and averaging period unconfirmed.
      source: createAirQualitySnapshotSource({
        endpoint: '/api/air-quality/india',
        hourly: true,
        // The India route refreshes its national snapshot every 20 minutes.
        reuseMs: 1_200_000,
        fetchImpl,
        now,
      }),
    },
    {
      id: 'openaq',
      viewDriven: true,
      // Its stations span the world: the card's badge reads Global.
      worldwide: true,
      title: msg('Worldwide · OpenAQ'),
      label: msg('Air quality · Worldwide'),
      network: 'OpenAQ',
      sourceLabel: 'OpenAQ · Worldwide',
      direct: false,
      parameters: OPENAQ_POLLUTANTS,
      requiresKeyId: 'openaq',
      source: createAirQualitySnapshotSource({
        endpoint: '/api/air-quality/openaq',
        hourly: true,
        fetchImpl,
        now,
      }),
    },
  ];
}
/** Compose explicit providers with separate coverage and cached national answers.
 * Create a new source when switching accounts. */
export function createAirQualitySource(options = {}) {
  const definitions =
    options.providers ?? createDefaultAirQualityProviders(options);
  if (!Array.isArray(definitions) || !definitions.length)
    throw new TypeError('Air quality requires providers');
  const registry = new Map();
  for (const definition of definitions) {
    if (
      typeof definition?.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(definition.id) ||
      registry.has(definition.id) ||
      typeof definition.source?.getSnapshot !== 'function' ||
      !Array.isArray(definition.parameters) ||
      !definition.title ||
      !definition.label ||
      !definition.network
    )
      throw new TypeError('Invalid air quality provider definition');
    registry.set(
      definition.id,
      Object.freeze({
        ...definition,
        parameters: Object.freeze([...definition.parameters]),
      }),
    );
  }
  // Parallel providers keep their own coverage.
  const coverageByProvider = new Map();
  return {
    definitions: Object.freeze([...registry.values()]),
    getCoverage: (provider) => coverageByProvider.get(provider) ?? null,
    async getSnapshot({ provider, ...request } = {}) {
      const entry = registry.get(provider);
      if (!entry) throw new Error(msg('Unknown air quality provider'));
      const readings = await entry.source.getSnapshot(request);
      request.signal?.throwIfAborted();
      coverageByProvider.set(provider, entry.source.getCoverage?.() ?? null);
      return readings;
    },
  };
}

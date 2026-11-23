import { msg } from '../../i18n/marker.js';
import { createEcccAirQualitySource } from './source.js';
import { AIR_QUALITY_PROVIDERS, AIR_QUALITY_BANDS } from './model.js';
import { SA_POLLUTANTS } from './southAfrica.js';
import { interpretHourly } from './interpretation.js';
import { OPENAQ_POLLUTANTS } from './openAq.js';
import { CPCB_POLLUTANTS } from './cpcb.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';

/**
 * Descriptor for a legacy ECCC-only injected snapshot source.
 *
 * `observation: false` makes a provider an index view of its own (Canada's
 * AQHI); every `observation: true` provider is drawn together in the station
 * views. `direct: true` marks a network publishing its own monitors, which
 * wins over an aggregator's copy of the same site (`merge.js`).
 */
export const ECCC_DEFINITION = Object.freeze({
  ...AIR_QUALITY_PROVIDERS.eccc,
  title: msg('Canada'),
  sourceLabel: 'ECCC MSC GeoMet',
  parameters: [],
  legend: AIR_QUALITY_BANDS,
  bandContext: 'air quality risk',
  observation: false,
  direct: true,
  refreshMs: 1_200_000,
});

/**
 * Fixed-route snapshot adapter; caller supplies the acquisition endpoint.
 *
 * `getSnapshot` answers one pollutant (`parameter`), interpreted on the EEA
 * hourly bands when `hourly`, or with `mode: 'aqi'` every pollutant the
 * snapshot holds: the layer folds them into one reading per station.
 */
export function createAirQualitySnapshotSource({
  endpoint,
  hourly = false,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  let coverage = null;
  return {
    getCoverage: () => coverage,
    async getSnapshot({ parameter = 'PM2.5', mode, signal, view } = {}) {
      const allPollutants = mode === 'aqi';
      signal?.throwIfAborted();
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(50_000),
        ...(signal ? [signal] : []),
      ]);
      const response = await fetchImpl(
        view
          ? `${endpoint}?view=${encodeURIComponent(view.join(','))}${allPollutants ? '&mode=aqi' : hourly ? `&parameter=${encodeURIComponent(parameter)}` : ''}`
          : endpoint,
        { signal: requestSignal },
      );
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new Error(
            msg('Provider key rejected. Check Provider Settings.'),
          );
        if (response.status === 428)
          throw Object.assign(new Error(msg('Provider API key required')), {
            code: 'no_key',
          });
        if (response.status === 429) {
          const body = await readResponseJsonCapped(
            response,
            8192,
            requestSignal,
          ).catch(() => null);
          signal?.throwIfAborted();
          const retryAt = Number.isFinite(body?.retryAt)
            ? Math.min(
                now() + 24 * 3600_000,
                Math.max(now() + 1000, body.retryAt),
              )
            : now() + 60_000;
          throw Object.assign(
            new Error(
              msg(
                'Provider request budget reached. Cached data will refresh later.',
              ),
            ),
            { retryAt },
          );
        }
        throw new Error(msg('Air quality provider unavailable'));
      }
      const payload = await readResponseJsonCapped(
        response,
        64 * 1024 * 1024,
        requestSignal,
      );
      if (
        payload?.schemaVersion !== 1 ||
        !Array.isArray(payload.stations) ||
        !Array.isArray(payload.readings)
      )
        throw new Error(msg('Malformed air quality snapshot'));
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
      coverage = { ...payload, readings: undefined };
      return readings;
    },
  };
}

/** Standalone-compatible defaults. Hosts can replace the entire provider list. */
export function createDefaultAirQualityProviders({
  canada = createEcccAirQualitySource(),
  fetchImpl,
  now,
} = {}) {
  return [
    { ...ECCC_DEFINITION, source: canada },
    {
      ...AIR_QUALITY_PROVIDERS.saaqis,
      title: msg('South Africa'),
      sourceLabel: 'SAAQIS · South Africa',
      observation: true,
      direct: true,
      parameters: SA_POLLUTANTS,
      averagingLabel: msg('Hourly average'),
      // SAAQIS's own index (1–10) is shown in a station's details only; the
      // views rate its concentrations on their own scale.
      indexLabel: msg('SAAQIS index'),
      bandContext: 'SAAQIS category',
      coverageNote: msg(
        'Station observations across all nine provinces. Municipalities without monitors have no measured coverage.',
      ),
      source: createAirQualitySnapshotSource({
        endpoint: '/api/air-quality/south-africa',
        hourly: true,
        fetchImpl,
        now,
      }),
    },
    {
      id: 'cpcb',
      title: msg('India'),
      label: msg('Air quality'),
      coverage: msg('India · CPCB via OGD'),
      network: 'CPCB',
      sourceLabel: 'CPCB · data.gov.in',
      observation: true,
      direct: true,
      parameters: CPCB_POLLUTANTS,
      requiresKeyId: 'data-gov-in',
      // The India route refreshes its national snapshot every 20 minutes.
      refreshMs: 1_200_000,
      indexLabel: msg('Index unavailable'),
      // Unrated until both the units and the averaging period are confirmed
      // (CPCB_UNITS_VERIFIED, CPCB_AVERAGING_MINUTES).
      interpretation: msg('Reported pollutant average · not an overall AQI'),
      source: createAirQualitySnapshotSource({
        endpoint: '/api/air-quality/india',
        hourly: true,
        fetchImpl,
        now,
      }),
    },
    {
      id: 'openaq',
      viewDriven: true,
      title: msg('Worldwide · OpenAQ'),
      label: msg('Air quality · Worldwide'),
      coverage: msg('Worldwide · available OpenAQ stations'),
      network: 'OpenAQ',
      sourceLabel: 'OpenAQ · Worldwide',
      observation: true,
      direct: false,
      parameters: OPENAQ_POLLUTANTS,
      requiresKeyId: 'openaq',
      averagingLabel: msg('Hourly average'),
      indexLabel: msg('Index unavailable'),
      coverageNote: msg(
        'Available monitoring stations worldwide. Unmonitored areas have no measured coverage.',
      ),
      source: createAirQualitySnapshotSource({
        endpoint: '/api/air-quality/openaq',
        hourly: true,
        fetchImpl,
        now,
      }),
    },
  ];
}

/** Compose explicit providers without selecting their network in the renderer. */
export function createAirQualitySource(options = {}) {
  const definitions =
    options.providers ?? createDefaultAirQualityProviders(options);
  if (!Array.isArray(definitions) || !definitions.length)
    throw new TypeError('Air quality requires providers');
  const registry = new Map();
  for (const definition of definitions) {
    if (
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
  // Providers are asked in parallel, so request order and coverage are kept
  // per provider: one provider's answer never stands in for another's.
  let coverage = null;
  const coverageByProvider = new Map();
  const generations = new Map();
  const cache = new Map();
  const clock = options.now || Date.now;
  return {
    providers: Object.freeze([...registry.keys()]),
    definitions: Object.freeze([...registry.values()]),
    /** The named provider's coverage, or the last answer from any provider. */
    getCoverage: (provider) =>
      provider === undefined
        ? coverage
        : (coverageByProvider.get(provider) ?? null),
    async getSnapshot({
      provider = registry.keys().next().value,
      ...request
    } = {}) {
      const entry = registry.get(provider);
      if (!entry) throw new Error(msg('Unknown air quality provider'));
      const ticket = (generations.get(provider) || 0) + 1;
      generations.set(provider, ticket);
      const cacheKey = `${provider}:${request.mode || request.parameter || ''}:${request.view?.join(',') || ''}`;
      const previous = cache.get(cacheKey);
      if (previous && clock() - previous.at < (entry.refreshMs || 0)) {
        coverage = previous.coverage;
        coverageByProvider.set(provider, previous.coverage);
        return previous.readings;
      }
      const readings = await entry.source.getSnapshot(request);
      request.signal?.throwIfAborted();
      if (ticket === generations.get(provider)) {
        coverage = entry.source.getCoverage?.() ?? null;
        coverageByProvider.set(provider, coverage);
        if (entry.refreshMs > 0) {
          cache.delete(cacheKey);
          cache.set(cacheKey, { readings, coverage, at: clock() });
          while (cache.size > 16) cache.delete(cache.keys().next().value);
        }
      }
      return readings;
    },
  };
}

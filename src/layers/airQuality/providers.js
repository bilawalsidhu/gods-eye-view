import { msg } from '../../i18n/marker.js';
import { createEcccAirQualitySource } from './source.js';
import { AIR_QUALITY_PROVIDERS, AIR_QUALITY_BANDS } from './model.js';
import { SA_POLLUTANTS, SA_INDEX_BANDS } from './southAfrica.js';
import { hourlyLegend, interpretHourly } from './interpretation.js';
import { OPENAQ_POLLUTANTS } from './openAq.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Descriptor for a legacy ECCC-only injected snapshot source. */
export const ECCC_DEFINITION = Object.freeze({
  ...AIR_QUALITY_PROVIDERS.eccc,
  title: msg('Canada'),
  sourceLabel: 'ECCC MSC GeoMet',
  parameters: [],
  legend: AIR_QUALITY_BANDS,
  observation: false,
  refreshMs: 1_200_000,
});

/** Fixed-route snapshot adapter; caller supplies the acquisition endpoint. */
export function createAirQualitySnapshotSource({
  endpoint,
  hourly = false,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
} = {}) {
  let coverage = null;
  return {
    getCoverage: () => coverage,
    async getSnapshot({ parameter = 'PM2.5', signal, view } = {}) {
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(50_000),
        ...(signal ? [signal] : []),
      ]);
      const response = await fetchImpl(
        view
          ? `${endpoint}?view=${encodeURIComponent(view.join(','))}${hourly ? `&parameter=${encodeURIComponent(parameter)}` : ''}`
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
        if (response.status === 429)
          throw new Error(
            msg(
              'Provider request budget reached. Cached data will refresh later.',
            ),
          );
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
            row.parameter === parameter &&
            Number.isFinite(row.observedMs) &&
            row.observedMs <= now() + 300_000 &&
            now() - row.observedMs <= 6 * 3600_000,
        )
        .map((row) => (hourly ? interpretHourly(row) : row))
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
      parameters: SA_POLLUTANTS,
      averagingLabel: msg('Hourly average'),
      indexLabel: msg('SAAQIS index'),
      coverageNote: msg(
        'Station observations across all nine provinces. Municipalities without monitors have no measured coverage.',
      ),
      interpretation: msg(
        'Colours show the provider-reported SAAQIS index (1–10), not WHO guideline compliance. Grey means no matching index.',
      ),
      legend: [
        ...SA_INDEX_BANDS.map((b, i) => ({
          color: b.color,
          label: b.label,
          range: `${i ? SA_INDEX_BANDS[i - 1].max + 1 : 1}–${b.max}`,
        })),
        { color: '#8cb4ce', label: msg('Index unavailable') },
      ],
      source: createAirQualitySnapshotSource({
        endpoint: '/api/air-quality/south-africa',
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
      parameters: OPENAQ_POLLUTANTS,
      requiresKeyId: 'openaq',
      averagingLabel: msg('Hourly average'),
      getLegend: hourlyLegend,
      indexLabel: msg('Index unavailable'),
      coverageNote: msg(
        'Available monitoring stations worldwide. Unmonitored areas have no measured coverage.',
      ),
      interpretation: msg(
        'GEV compares the selected pollutant with EEA hourly bands. This is not an overall station AQI or a local official index.',
      ),
      legend: [{ color: '#8cb4ce', label: msg('Index unavailable') }],
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
  let coverage = null;
  let generation = 0;
  const cache = new Map();
  const clock = options.now || Date.now;
  return {
    providers: Object.freeze([...registry.keys()]),
    definitions: Object.freeze([...registry.values()]),
    getCoverage: () => coverage,
    async getSnapshot({
      provider = registry.keys().next().value,
      ...request
    } = {}) {
      const entry = registry.get(provider);
      if (!entry) throw new Error(msg('Unknown air quality provider'));
      const ticket = ++generation;
      const cacheKey = `${provider}:${request.parameter || ''}:${request.view?.join(',') || ''}`;
      const previous = cache.get(cacheKey);
      if (previous && clock() - previous.at < (entry.refreshMs || 0)) {
        coverage = previous.coverage;
        return previous.readings;
      }
      const readings = await entry.source.getSnapshot(request);
      request.signal?.throwIfAborted();
      if (ticket === generation) {
        coverage = entry.source.getCoverage?.() ?? null;
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

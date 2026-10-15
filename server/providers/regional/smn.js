import { readResponseBytesCapped } from '../common/http.js';
import { readSmnZip, SMN_ZIP_MAX_BYTES } from './smn-zip.js';
import {
  parseSmnStations,
  parseSmnObservations,
  selectSmnObservation,
} from './smn-model.js';

const BASE_URL = 'https://ssl.smn.gob.ar/dpd/zipopendata.php?dato=';

/** Coverage prefilter, not a national boundary or a guarantee of a station. */
export function isSmnCoveragePoint(point) {
  return (
    Number.isFinite(point?.latitude) &&
    Number.isFinite(point?.longitude) &&
    point.latitude >= -56 &&
    point.latitude <= -21 &&
    point.longitude >= -74 &&
    point.longitude <= -52
  );
}

/** Shared, bounded station/weather downloads; no request-specific URL input. */
export function createSmnWeatherProvider({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  timeoutMs = 4000,
} = {}) {
  let stations = null;
  let stationsAt = 0;
  let observations = null;
  let observationsAt = 0;
  let retryAt = 0;
  let pending = null;

  async function download(kind, filename, signal) {
    const response = await fetchImpl(`${BASE_URL}${kind}`, {
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`SMN returned ${response.status}`);
    return readSmnZip(
      await readResponseBytesCapped(response, SMN_ZIP_MAX_BYTES, signal),
      filename,
    );
  }

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const [catalog, text] = await Promise.all([
        stations && now() - stationsAt < 24 * 60 * 60_000
          ? stations
          : download(
              'estaciones',
              /^estaciones_smn\.txt$/,
              controller.signal,
            ).then(parseSmnStations),
        download('tiepre', /^estado_tiempo\d{8}\.txt$/, controller.signal),
      ]);
      const rows = parseSmnObservations(text, catalog);
      if (!catalog.length || !rows.length) throw new Error('Empty SMN data');
      if (catalog !== stations) stationsAt = now();
      stations = catalog;
      observations = rows;
      observationsAt = now();
    } catch {
      observations = null;
      retryAt = now() + 60_000;
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  return async (point) => {
    // Coverage prefilter, not a national boundary. Near-border queries can use
    // an explicitly identified SMN station; the 50 km cutoff still applies.
    if (!isSmnCoveragePoint(point)) return null;
    if (now() < retryAt) return null;
    if (!observations || now() - observationsAt >= 5 * 60_000) {
      if (!pending)
        pending = refresh().finally(() => {
          pending = null;
        });
      await pending;
    }
    return selectSmnObservation(observations || [], point, now());
  };
}

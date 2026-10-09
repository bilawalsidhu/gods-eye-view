/**
 * One fetch step per network, each returning canonical station records.
 *
 * Transport only: the shape of every payload is decided by the pure adapters
 * under `src/layers/alpineStations/networks/`, which are exercised directly by
 * unit tests. What lives here is the part that needs a socket — which URLs,
 * which caps, which decoder, and how many round trips.
 */

import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { joinSlfStations } from '../../../src/layers/alpineStations/networks/slf.js';
import { joinSmnStations } from '../../../src/layers/alpineStations/networks/smn.js';
import {
  TAWES_PARAMETER_QUERY,
  joinTawesStationRecords,
  tawesReadings,
  tawesStationIds,
} from '../../../src/layers/alpineStations/networks/tawes.js';
import {
  SLF_MEASUREMENTS_MAX_BYTES,
  SLF_MEASUREMENTS_URL,
  SLF_STATIONS_MAX_BYTES,
  SLF_STATIONS_URL,
  SMN_METADATA_ENCODING,
  SMN_METADATA_MAX_BYTES,
  SMN_METADATA_URL,
  SMN_OBSERVATIONS_MAX_BYTES,
  SMN_OBSERVATIONS_URL,
  TAWES_DATASET,
  TAWES_METADATA_MAX_BYTES,
  TAWES_METADATA_URL,
  TAWES_OBSERVATIONS_MAX_BYTES,
  TAWES_STATIONS_PER_REQUEST,
  UPSTREAM_TIMEOUT_MS,
} from './upstreams.js';

const USER_AGENT = 'Gods Eye View (public Alpine weather station context)';

/** A reader that never relays an upstream's own wording to the client. */
export function createUpstreamReader({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  async function request(url, accept, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('alpine_upstream_unavailable');
    }
    return response;
  }
  return {
    timeoutMs,
    async json(url, cap, signal) {
      const response = await request(
        url,
        'application/geo+json,application/json',
        signal,
      );
      return readResponseJsonCapped(response, cap, signal);
    },
    async text(url, cap, signal) {
      const response = await request(url, 'text/csv,text/plain', signal);
      return readResponseTextCapped(response, cap, signal);
    },
    /**
     * Bytes, for a body whose encoding is not UTF-8 and must be decoded
     * explicitly rather than guessed by `Response.text()`.
     */
    async decoded(url, cap, encoding, signal) {
      const response = await request(url, 'text/csv,text/plain', signal);
      const bytes = await readResponseBytesCapped(response, cap, signal);
      return new TextDecoder(encoding).decode(bytes);
    },
  };
}

/** SLF IMIS: the station list, then the rolling measurement window. */
export async function fetchSlfStations(reader, signal) {
  // Sequential on purpose. The station list is the cheap call, so a network
  // that is down fails on 31 KB instead of on 3 MB.
  const stations = await reader.json(
    SLF_STATIONS_URL,
    SLF_STATIONS_MAX_BYTES,
    signal,
  );
  if (!Array.isArray(stations)) throw new Error('alpine_invalid_payload');
  const measurements = await reader.json(
    SLF_MEASUREMENTS_URL,
    SLF_MEASUREMENTS_MAX_BYTES,
    signal,
  );
  if (!Array.isArray(measurements)) throw new Error('alpine_invalid_payload');
  return joinSlfStations(stations, measurements);
}

/**
 * SwissMetNet: the metadata CSV, then the whole-network current values.
 *
 * `metadataCache` is supplied by the caller so identity can be held for a day
 * while the readings refresh every few minutes.
 */
export async function fetchSmnStations(reader, signal, { readMetadata }) {
  const [metadata, observations] = await Promise.all([
    readMetadata(() =>
      reader.decoded(
        SMN_METADATA_URL,
        SMN_METADATA_MAX_BYTES,
        SMN_METADATA_ENCODING,
        signal,
      ),
    ),
    reader.text(SMN_OBSERVATIONS_URL, SMN_OBSERVATIONS_MAX_BYTES, signal),
  ]);
  const stations = joinSmnStations(metadata, observations);
  if (!stations.length) throw new Error('alpine_invalid_payload');
  return stations;
}

/** The observation URL for one chunk of GeoSphere station ids. */
export function tawesObservationUrl(ids) {
  const url = new URL(TAWES_DATASET);
  url.search = new URLSearchParams({
    parameters: TAWES_PARAMETER_QUERY,
    output_format: 'geojson',
    station_ids: ids.join(','),
  }).toString();
  return url.href;
}

/**
 * GeoSphere TAWES: metadata for the id list, then observations in chunks.
 *
 * The chunks are merged by concatenating features and taking the union of the
 * timestamp arrays per chunk. They are NOT flattened into one array first,
 * because a `data` index is only meaningful against the `timestamps` array of
 * the response it came in — see `tawesReadingIndex`.
 */
export async function fetchTawesStations(reader, signal, { readMetadata }) {
  const metadata = await readMetadata(() =>
    reader.json(TAWES_METADATA_URL, TAWES_METADATA_MAX_BYTES, signal),
  );
  const ids = tawesStationIds(metadata);
  if (!ids.length) throw new Error('alpine_invalid_payload');
  const chunks = [];
  for (let at = 0; at < ids.length; at += TAWES_STATIONS_PER_REQUEST)
    chunks.push(ids.slice(at, at + TAWES_STATIONS_PER_REQUEST));
  const responses = await Promise.all(
    chunks.map((chunk) =>
      reader.json(
        tawesObservationUrl(chunk),
        TAWES_OBSERVATIONS_MAX_BYTES,
        signal,
      ),
    ),
  );
  const readings = new Map();
  for (const response of responses)
    for (const [code, reading] of tawesReadings(response))
      readings.set(code, reading);
  return joinTawesStationRecords(metadata, readings);
}

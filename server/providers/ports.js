import {
  WPI_MIRROR_URL,
  normalizeWpiFeatures,
} from '../../src/layers/ports/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const DAY = 24 * 60 * 60 * 1000;
export const WPI_PAGE_SIZE = 1000;
export const WPI_MAX_PAGES = 8;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_RESPONSE_PORTS = WPI_PAGE_SIZE * WPI_MAX_PAGES;
const FIELDS = [
  'objectid',
  'wpinumber',
  'regionname',
  'main_port_name',
  'alternate_name',
  'wpi_cc',
  'unlocode',
  'harbor_size_code',
  'harbor_type_code',
  'channel_depth',
  'cargo_pier_depth',
  'fac_container',
  'fac_solidbulk',
  'fac_oilterm',
  'fac_lngterm',
].join(',');

export function wpiPageUrl(offset, count = WPI_PAGE_SIZE) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError('Invalid port page offset');
  if (!Number.isInteger(count) || count < 1 || count > WPI_PAGE_SIZE)
    throw new RangeError('Invalid port page size');
  const url = new URL(`${WPI_MIRROR_URL}/query`);
  const params = url.searchParams;
  params.set('where', '1=1');
  params.set('outFields', FIELDS);
  params.set('returnGeometry', 'true');
  params.set('outSR', '4326');
  params.set('f', 'geojson');
  params.set('orderByFields', 'objectid ASC');
  params.set('resultOffset', String(offset));
  params.set('resultRecordCount', String(count));
  return url.href;
}

function validEpoch(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value < 9_000_000_000_000
    ? value
    : null;
}

/** Fixed-origin server proxy; never follows request-supplied upstream URLs. */
export function portsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  refreshMs = DAY,
  staleMs = 7 * DAY,
  retryMs = 15 * 60 * 1000,
} = {}) {
  let lastGood = null;
  let retryAt = 0;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function fetchCapped(url, bytes) {
    const signal = AbortSignal.timeout(15_000);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent':
          "God's Eye View WPI layer (https://github.com/bilawalsidhu/gods-eye-view)",
      },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error('wpi_upstream_unavailable');
    }
    return readResponseJsonCapped(response, bytes, signal);
  }

  async function mirrorLastEditAt() {
    try {
      const url = `${WPI_MIRROR_URL}?f=json`;
      const metadata = await fetchCapped(url, MAX_METADATA_BYTES);
      if (
        metadata?.id !== 17 ||
        metadata?.objectIdField?.toLowerCase() !== 'objectid'
      )
        return null;
      return validEpoch(metadata.editingInfo?.lastEditDate);
    } catch {
      return null;
    }
  }

  async function refresh() {
    const mirrorLastEdit = await mirrorLastEditAt();
    const features = [];
    let lastObjectId = -1;
    let complete = false;
    for (let page = 0; page < WPI_MAX_PAGES; page++) {
      const payload = await fetchCapped(
        wpiPageUrl(page * WPI_PAGE_SIZE),
        MAX_PAGE_BYTES,
      );
      if (
        payload?.type !== 'FeatureCollection' ||
        !Array.isArray(payload.features) ||
        payload.features.length > WPI_PAGE_SIZE ||
        payload.error
      )
        throw new Error('wpi_invalid_page');
      const batch = payload.features;
      // ArcGIS pagination must be stable and monotonic, or duplicates and
      // missing ports could be silently reported as a complete snapshot.
      for (const feature of batch) {
        const id = feature?.properties?.objectid;
        if (!Number.isSafeInteger(id) || id <= lastObjectId)
          throw new Error('wpi_non_monotonic_page');
        lastObjectId = id;
      }
      features.push(...batch);
      if (batch.length < WPI_PAGE_SIZE) {
        if (payload.exceededTransferLimit === true)
          throw new Error('wpi_inconsistent_pagination');
        complete = true;
        break;
      }
    }
    if (!features.length) throw new Error('wpi_empty_snapshot');
    const records = normalizeWpiFeatures(features);
    if (!records?.length) throw new Error('wpi_invalid_snapshot');
    if (features.length > MAX_RESPONSE_PORTS)
      throw new Error('wpi_snapshot_overflow');
    const retrievedAt = now();
    lastGood = {
      records,
      retrievedAt,
      mirrorLastEditAt: mirrorLastEdit,
      // Only the government mirror's last-edit is known; NGA edition not known.
      ngaPublicationDate: null,
      complete,
      partial: !complete,
    };
    retryAt = retrievedAt + refreshMs;
    return lastGood;
  }

  async function snapshot() {
    const at = now();
    if (lastGood && at - lastGood.retrievedAt < refreshMs)
      return { ...lastGood, stale: false };
    if (at >= retryAt) {
      try {
        await coalesceProxyRequest(inFlight, 'refresh', refresh).promise;
      } catch {
        retryAt = now() + retryMs;
      }
    }
    if (!lastGood || now() - lastGood.retrievedAt > staleMs)
      throw new Error('wpi_unavailable');
    return {
      ...lastGood,
      stale: now() - lastGood.retrievedAt >= refreshMs,
    };
  }

  const handler = async (req, res) => {
    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(value?.stale ? { 'X-Data-Stale': 'true' } : {}),
        ...(value?.partial ? { 'X-Data-Partial': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return send(405, { error: 'method_not_allowed' });
    if ((req.url || '/').split('?')[0] !== '/')
      return send(404, { error: 'unknown_route' });
    if (!allow(clientKey(req)))
      return send(429, { error: 'rate_limited' });
    try {
      return send(200, await snapshot());
    } catch {
      return send(502, { error: 'wpi_unavailable' });
    }
  };
  return {
    name: 'world-port-index',
    configureServer({ middlewares }) {
      middlewares.use('/api/ports', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ports', handler);
    },
  };
}

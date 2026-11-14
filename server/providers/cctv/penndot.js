import { fetchHlsBytes } from './stream.js';
import { cameraDisplayCode, prioritizeSources } from './normalize.js';
import { DEFAULT_PENNDOT_MAX_SOURCES } from './constants.js';

const ORIGIN = 'https://511pa.com';
const TOKEN_URL =
  'https://pa.arcadis-ivds.com/api/SecureTokenUri/GetSecureTokenUriBySourceId';
const PAGE_SIZE = 100;
const MAX_PAGES = 32;
const PENNSYLVANIA_ANCHORS = [
  { lat: 39.9526, lon: -75.1652 }, // Philadelphia
  { lat: 40.4406, lon: -79.9959 }, // Pittsburgh
  { lat: 40.2732, lon: -76.8867 }, // Harrisburg
  { lat: 42.1292, lon: -80.0851 }, // Erie
  { lat: 41.4089, lon: -75.6624 }, // Scranton
  { lat: 40.7934, lon: -77.86 }, // State College
  { lat: 40.5187, lon: -78.3947 }, // Altoona
];

function streamUrl(value) {
  return typeof value === 'string' &&
    /^https:\/\/pa-se[1-4]\.arcadis-ivds\.com:8200\/chan-\d+\/index\.m3u8$/.test(
      value,
    )
    ? value
    : null;
}

/** The public player sends these origin headers on manifests and MP4 objects. */
export function fetchPennDotMedia(url, init, fetchImpl = fetch) {
  const registeredOrigin =
    /^https:\/\/pa-se[1-4]\.arcadis-ivds\.com:8200\/chan-\d+\//.test(url);
  return fetchImpl(
    url,
    registeredOrigin
      ? {
          ...init,
          headers: { ...init?.headers, Origin: ORIGIN, Referer: `${ORIGIN}/` },
        }
      : init,
  );
}

/** 511PA supplies WGS84 POINTs; road traffic direction is not a PTZ heading. */
export function pennDotCameraToSources(site) {
  if (!site || site.visible === false || !Array.isArray(site.images)) return [];
  const geo = site.latLng?.geography;
  if (geo?.coordinateSystemId !== 4326) return [];
  const point =
    typeof geo.wellKnownText === 'string' &&
    geo.wellKnownText.match(
      /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i,
    );
  if (!point) return [];
  const [, lon, lat] = point.map(Number);
  // State envelope, including cameras just over the border shown by 511PA.
  if (!(lat >= 39.6 && lat <= 42.6 && lon >= -80.6 && lon <= -74.5)) return [];
  const county = typeof site.county === 'string' ? site.county.trim() : '';
  // Some newer/portable cameras repeat the asset key as their location.
  const publishedLocation =
    typeof site.location === 'string' &&
    !/^CAM\d+[A-Z0-9_-]*$/i.test(site.location.trim())
      ? site.location
      : '';
  const location =
    [publishedLocation, site.roadway, site.cameraName]
      .find((value) => typeof value === 'string' && value.trim())
      ?.trim() || 'Pennsylvania traffic camera';
  return site.images.flatMap((image) => {
    if (
      !image ||
      !Number.isSafeInteger(image.id) ||
      image.id <= 0 ||
      image.disabled === true ||
      image.blocked === true
    )
      return [];
    const snapshotUrl = `${ORIGIN}/map/Cctv/${image.id}`;
    const video =
      image.videoDisabled === true ? null : streamUrl(image.videoUrl);
    return [
      {
        id: `511pa-${image.id}`,
        name: location,
        city: county ? `${county} County, PA` : 'Pennsylvania',
        cityId: county
          ? `pa-${county.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
          : 'pennsylvania',
        provider: 'PennDOT / 511PA',
        sourceKind: '511pa-public-camera',
        // Map labels use 511PA's road/intersection, not its internal asset key.
        code: cameraDisplayCode(location.toUpperCase()),
        lat,
        lon,
        headingConfidence: 'unknown',
        feedType: video ? 'hls' : 'image',
        url: video || snapshotUrl,
        snapshotUrl,
        credit: [county && `${county} County`, image.description]
          .filter(Boolean)
          .join(' — '),
        license:
          '© PennDOT / 511PA. Public camera viewer; PennDOT data-feed and video-sharing terms apply to redistribution.',
      },
    ];
  });
}

/** Bounded statewide catalog pagination, with optional county filters. */
export async function loadPennDotSources({ fetchImpl = fetch } = {}) {
  const requested = String(process.env.CCTV_511PA_COUNTIES || 'all').trim();
  const counties =
    requested.toLowerCase() === 'all'
      ? ['']
      : [
          ...new Set(
            requested
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ];
  if (!counties.length || counties.length > 67) return [];
  const signal = AbortSignal.timeout(30_000);
  const sources = new Map();
  let pages = 0;
  try {
    for (const county of counties) {
      let start = 0;
      let total = 1;
      while (start < total) {
        if (++pages > MAX_PAGES) throw new Error('511PA catalog page limit');
        const query = {
          columns: [
            {
              name: 'county',
              ...(county ? { search: { value: county } } : {}),
            },
            { name: 'cameraName' },
          ],
          order: [{ column: 1, dir: 'asc' }],
          start,
          length: PAGE_SIZE,
          search: { value: '' },
        };
        const url = new URL('/List/GetData/Cameras', ORIGIN);
        url.searchParams.set('query', JSON.stringify(query));
        url.searchParams.set('lang', 'en-US');
        const body = await fetchHlsBytes(url.href, {
          fetchImpl,
          signal,
          maxBytes: 1024 * 1024,
        });
        const payload = JSON.parse(body.toString('utf8'));
        total = payload.recordsFiltered;
        if (
          !Number.isSafeInteger(total) ||
          total < 0 ||
          total > 10_000 ||
          !Array.isArray(payload.data) ||
          payload.data.length > PAGE_SIZE ||
          (start < total && !payload.data.length)
        )
          throw new Error('Invalid 511PA catalog page');
        for (const site of payload.data) {
          if (
            county &&
            String(site?.county || '').toLowerCase() !== county.toLowerCase()
          )
            continue;
          for (const source of pennDotCameraToSources(site))
            sources.set(source.id, source);
        }
        start += payload.data.length;
      }
    }
    const rawCap = Number(
      process.env.CCTV_511PA_MAX_SOURCES || DEFAULT_PENNDOT_MAX_SOURCES,
    );
    const cap = Number.isFinite(rawCap)
      ? Math.max(1, Math.min(3000, Math.floor(rawCap)))
      : DEFAULT_PENNDOT_MAX_SOURCES;
    const cameras = [...sources.values()];
    const kept = prioritizeSources(cameras, cap, PENNSYLVANIA_ANCHORS);
    console.log('[CCTV] Loaded 511PA camera sources:', kept.length);
    return kept;
  } catch (error) {
    console.warn('[CCTV] 511PA catalog unavailable:', error?.message || error);
    return [];
  }
}

/** Follow the same two-step, public token flow as 511PA's Show Video button. */
export function createPennDotStreamResolver({
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  let retryAt = 0;
  const guardedFetch = async (target, init) => {
    if (now() < retryAt)
      throw new Error('511PA video service temporarily rate limited');
    const response = await fetchImpl(target, init);
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(raw || '') - now();
      retryAt =
        now() +
        Math.max(
          5000,
          Math.min(3600000, Number.isFinite(delay) ? delay : 60000),
        );
    }
    return response;
  };
  return async (url, signal, cameraId) => {
    if (!/^511pa-[1-9]\d*$/.test(cameraId || '') || !streamUrl(url)) return url;
    signal?.throwIfAborted();
    const cached = cache.get(cameraId);
    if (cached?.base === url && now() < cached.expiresAt) return cached.url;
    if (inflight.has(cameraId)) return inflight.get(cameraId);
    if (now() < retryAt)
      throw new Error('511PA video service temporarily rate limited');
    const pending = (async () => {
      const endpoint = new URL('/Camera/GetVideoUrl', ORIGIN);
      endpoint.searchParams.set('imageId', cameraId.slice(6));
      endpoint.searchParams.set('_', String(now()));
      const auth = JSON.parse(
        (
          await fetchHlsBytes(endpoint.href, {
            fetchImpl: guardedFetch,
            signal,
            maxBytes: 16 * 1024,
          })
        ).toString('utf8'),
      );
      if (
        !auth ||
        typeof auth !== 'object' ||
        !/^[a-f0-9-]{36}$/i.test(auth.token || '') ||
        !/^\d+$/.test(String(auth.sourceId || '')) ||
        !/^(PennDOT|PTC)$/.test(auth.systemSourceId || '')
      )
        throw new Error('Invalid 511PA video authorization');
      const request = async (target, init) =>
        guardedFetch(target, {
          ...init,
          method: 'POST',
          headers: {
            ...init.headers,
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Referer: `${ORIGIN}/`,
          },
          body: JSON.stringify({
            token: auth.token,
            sourceId: auth.sourceId,
            systemSourceId: auth.systemSourceId,
          }),
        });
      const suffix = JSON.parse(
        (
          await fetchHlsBytes(TOKEN_URL, {
            fetchImpl: request,
            signal,
            maxBytes: 16 * 1024,
          })
        ).toString('utf8'),
      );
      if (typeof suffix !== 'string' || !/^\?token=[a-f0-9]{64}$/i.test(suffix))
        throw new Error('Invalid 511PA stream token');
      signal?.throwIfAborted();
      const signed = url + suffix;
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(cameraId, {
        base: url,
        url: signed,
        expiresAt: now() + 30_000,
      });
      return signed;
    })().finally(() => inflight.delete(cameraId));
    inflight.set(cameraId, pending);
    return pending;
  };
}

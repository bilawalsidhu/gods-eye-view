import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeSourceItem, parsePointString } from './normalize.js';
import { fetchHlsBytes } from './stream.js';

export const GEORGIA_MAX_SOURCES = 1450;
export const GEORGIA_COUNTIES = Object.freeze([
  'Paulding',
  'Bartow',
  'Cobb',
  'Douglas',
  'Carroll',
  'Haralson',
  'Polk',
  'Fulton',
  'DeKalb',
]);
const hosts = new Set(
  Array.from(
    { length: 7 },
    (_, i) => `sfs-msc-pub-lq-0${i + 1}.navigator.dot.ga.gov`,
  ),
);
// Dates only, never authorization URLs. Prevent client retries defeating 429.
const cooldowns = new Map();

function unavailable(status = 503, retryAfterSeconds = 2) {
  return Object.assign(new Error('Georgia public video unavailable'), {
    status,
    retryAfterSeconds,
    fatal: true,
  });
}

export function normalizeGeorgiaCatalog(payload) {
  if (!Array.isArray(payload?.cameras)) throw unavailable();
  const result = new Map();
  for (const row of payload.cameras) {
    const siteId = String(row?.id || '');
    if (!/^\d{1,10}$/.test(siteId) || !GEORGIA_COUNTIES.includes(row.county))
      continue;
    if (row.viewerUrl !== `https://511ga.org/map#camera-${siteId}`) continue;
    if (
      /\(([^()]*)\)\s*$/
        .exec(row.location || '')?.[1]
        ?.trim()
        .toLowerCase() !== row.county.toLowerCase()
    )
      continue;
    const { lat, lon } = parsePointString(row.wkt);
    if (!(lat >= 30.3 && lat <= 35.1 && lon >= -85.7 && lon <= -80.7)) continue;
    const view = row.views?.find(
      (v) =>
        !v.disabled &&
        !v.blocked &&
        !v.videoDisabled &&
        v.videoType === 'application/x-mpegURL',
    );
    if (
      !Number.isSafeInteger(view?.id) ||
      view.id < 1 ||
      !hosts.has(view.videoHost) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(row.name || '')
    )
      continue;
    if (result.has(siteId)) continue;
    result.set(siteId, {
      ...normalizeSourceItem({
        id: `georgia511-${siteId}`,
        name: String(row.location).slice(0, 240),
        city: `${row.county} County, Georgia`,
        cityId: `georgia-${row.county.toLowerCase()}`,
        provider: 'Georgia511 / Georgia Department of Transportation',
        credit: 'Georgia511 public cameras',
        code: row.name,
        lat,
        lon,
        feedType: 'hls',
        sourceKind: 'georgia511-public',
        // Stable identity only. The temporary HLS URL is never a source record.
        url: `https://511ga.org/Camera/GetVideoUrl?imageId=${view.id}`,
        license:
          'Operator-supplied metadata; provider terms apply. No catalog or media license grant is implied.',
      }),
      pack: 'georgia511',
      county: row.county,
      viewerUrl: row.viewerUrl,
      availability: 'Listed by Georgia511; live status checked when opened',
      georgiaViewId: view.id,
      georgiaHost: view.videoHost,
      georgiaStreamName: row.name,
    });
  }
  return [...result.values()].slice(0, GEORGIA_MAX_SOURCES);
}

export async function loadGeorgiaSources({ sourceRoot }) {
  if (process.env.CCTV_GEORGIA511_ENABLED === '0') return [];
  try {
    const file = path.join(sourceRoot, 'config/cctv_sources.georgia511.json');
    if ((await fs.stat(file)).size > 4 * 1024 * 1024) return [];
    return normalizeGeorgiaCatalog(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return [];
  }
}

/** Exact registered stream, exact published host, no redirects or URL escape. */
export function validateGeorgiaMediaUrl(
  value,
  source,
  { master = false } = {},
) {
  try {
    const u = new URL(value);
    const prefix = `/rtplive/${source.georgiaStreamName}/`;
    const leaf = u.pathname.slice(prefix.length);
    if (
      source.pack !== 'georgia511' ||
      !hosts.has(source.georgiaHost) ||
      u.protocol !== 'https:' ||
      u.hostname !== source.georgiaHost ||
      u.port ||
      u.username ||
      u.password ||
      u.hash ||
      !u.pathname.startsWith(prefix) ||
      !(master
        ? leaf === 'playlist.m3u8'
        : /^[A-Za-z0-9_-]+\.(?:m3u8|ts)$/.test(leaf))
    )
      throw unavailable();
    return u.href;
  } catch {
    throw unavailable();
  }
}

/** One closure per owned HLS session. Anonymous issuance, no cookie/key/header impersonation. */
export function createGeorgiaSession(
  source,
  { fetchImpl = fetch, now = Date.now, refreshMs = 60000 } = {},
) {
  if (
    source.pack !== 'georgia511' ||
    !Number.isSafeInteger(source.georgiaViewId) ||
    source.georgiaViewId < 1
  )
    throw unavailable();
  let current = null,
    issuedAt = -Infinity,
    inflight = null,
    disposed = false;
  const dispose = () => {
    disposed = true;
    current = null;
    issuedAt = -Infinity;
  };
  const onError = ({ status, retryAfterSeconds }) => {
    if (status !== 429) return;
    cooldowns.set(
      source.georgiaViewId,
      now() + (retryAfterSeconds || 60) * 1000,
    );
    while (cooldowns.size > GEORGIA_MAX_SOURCES)
      cooldowns.delete(cooldowns.keys().next().value);
  };
  const resolveUrl = ({ signal }) => {
    if (disposed || signal.aborted) return Promise.reject(unavailable());
    const until = cooldowns.get(source.georgiaViewId) || 0;
    if (until > now())
      return Promise.reject(
        unavailable(429, Math.ceil((until - now()) / 1000)),
      );
    if (current && now() - issuedAt < refreshMs)
      return Promise.resolve(current);
    if (inflight) return inflight;
    // Expired authorization is cleared before the refresh; never retry it.
    current = null;
    inflight = (async () => {
      try {
        const bytes = await fetchHlsBytes(
          `https://511ga.org/Camera/GetVideoUrl?imageId=${source.georgiaViewId}`,
          {
            fetchImpl,
            signal,
            maxBytes: 16 * 1024,
          },
        );
        signal.throwIfAborted();
        if (disposed) throw unavailable();
        const value = JSON.parse(bytes.toString('utf8'));
        if (typeof value !== 'string') throw unavailable();
        current = validateGeorgiaMediaUrl(value, source, { master: true });
        issuedAt = now();
        return current;
      } catch (error) {
        current = null;
        if (error.status === 429) {
          const seconds = error.retryAfterSeconds || 60;
          cooldowns.set(source.georgiaViewId, now() + seconds * 1000);
          // Bound even if this helper is called outside the fixed manifest.
          while (cooldowns.size > GEORGIA_MAX_SOURCES)
            cooldowns.delete(cooldowns.keys().next().value);
          throw unavailable(429, seconds);
        }
        throw unavailable(
          [401, 403].includes(error.status) ? error.status : 503,
        );
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  return {
    resolveUrl,
    dispose,
    onError,
    validateUrl: (value) => validateGeorgiaMediaUrl(value, source),
  };
}

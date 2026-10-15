import fs from 'node:fs';
import path from 'node:path';
import { fallbackHeadingFromId } from './normalize.js';

/** Public UTMC snapshots only; no arbitrary camera or upstream URLs. */
export function isGatesheadImageUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://netrafficcams.co.uk' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/sites\/default\/files\/images\/cameras\/[A-Za-z0-9_.-]+\.jpg$/.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

export function loadGatesheadSourcesFromCatalog({
  sourceRoot = process.cwd(),
  pack = 'gateshead',
} = {}) {
  const a19 = pack === 'a19';
  const additional = pack === 'utmc';
  try {
    const catalog = JSON.parse(
      fs.readFileSync(
        path.join(
          sourceRoot,
          `config/cctv_sources.${additional ? 'utmc' : a19 ? 'a19' : 'gateshead'}.json`,
        ),
        'utf8',
      ),
    );
    const seen = new Set();
    return (Array.isArray(catalog.cameras) ? catalog.cameras : [])
      .slice(0, additional ? 500 : 150)
      .flatMap((row) => {
        if (
          !row ||
          typeof row.name !== 'string' ||
          !(
            additional ? /^utmc-\d+$/ : a19 ? /^a19-\d+$/ : /^gateshead-\d+$/
          ).test(row.id) ||
          (additional &&
            (typeof row.city !== 'string' || row.city.length > 80)) ||
          (a19 &&
            ![
              'North Tyneside',
              'Northumberland',
              'South Tyneside',
              'Sunderland',
            ].includes(row.city)) ||
          seen.has(row.id) ||
          !isGatesheadImageUrl(row.url) ||
          !Number.isFinite(row.lat) ||
          !Number.isFinite(row.lon) ||
          row.lat < (additional ? 49 : a19 ? 54.7 : 54.8) ||
          row.lat > (additional ? 61 : a19 ? 55.2 : 55.1) ||
          row.lon < (additional ? -9 : -2) ||
          row.lon > (additional ? 2 : -1.3)
        )
          return [];
        seen.add(row.id);
        return [
          {
            ...row,
            city: a19 || additional ? row.city : 'Gateshead',
            cityId: additional ? 'utmc-northeast' : a19 ? 'a19' : 'gateshead',
            provider: 'Tyne and Wear UTMC · public snapshots',
            credit:
              '© Newcastle City Council / UTMC · normally 1–5 min · check image timestamp',
            license: 'UTMC Open Data Service · Open Government Licence 3.0',
            headingDeg: fallbackHeadingFromId(row.id),
            headingConfidence: 'low',
            pitchDeg: -18,
            fovDeg: 44,
            rangeM: 145,
            mountHeightM: 8,
            groundElevationM: 60,
            feedType: 'image',
            sourceKind: 'gateshead-utmc',
            snapshotUrl: row.url,
          },
        ];
      });
  } catch (error) {
    console.warn('[CCTV] Gateshead catalog unavailable:', error.message);
    return [];
  }
}

export function loadA19SourcesFromCatalog(options = {}) {
  return loadGatesheadSourcesFromCatalog({ ...options, pack: 'a19' });
}

export function loadAdditionalUtmcSourcesFromCatalog(options = {}) {
  return loadGatesheadSourcesFromCatalog({ ...options, pack: 'utmc' });
}

/** Share requests across the map and preview; one provider fetch per camera/minute. */
export function createGatesheadSnapshotReader({
  readImage,
  now = Date.now,
} = {}) {
  const frames = new Map();
  return async (url) => {
    if (!isGatesheadImageUrl(url)) return null;
    const time = now();
    const cached = frames.get(url);
    if (cached && (cached.pending || time - cached.at < 60000))
      return cached.promise;
    if (frames.size >= 150 && !frames.has(url))
      frames.delete(frames.keys().next().value);
    const entry = { at: time, pending: true };
    const freshUrl = new URL(url);
    freshUrl.searchParams.set('gev_minute', String(Math.floor(time / 60000)));
    entry.promise = Promise.resolve()
      .then(() => readImage(freshUrl.href))
      .catch(() => null)
      .finally(() => {
        entry.pending = false;
        entry.at = now();
      });
    frames.set(url, entry);
    return entry.promise;
  };
}

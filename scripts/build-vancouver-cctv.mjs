/**
 * Build the Vancouver CCTV source pack for God's Eye View.
 *
 * Data facts (verified 2026-09-15):
 * - The City of Vancouver traffic-camera site is a set of HTML pages, one per
 *   intersection (https://trafficcams.vancouver.ca/<page>.htm). Each page
 *   carries up to four directional cameras, each rendered as
 *   <div class="camera"><p><strong>North</strong></p><img src="cameraimages/…"/></div>.
 * - The pages embed no coordinates. The official map data source is the KML the
 *   map iframe uses (m_cov_map.js → googleKmlUrl): one placemark per
 *   intersection, holding the intersection name, its .htm page, and a Point.
 *   The camera coordinates are therefore per intersection; the directional
 *   cameras of a page share that point (the city publishes no per-camera
 *   positions).
 * - Camera frames are keyless public stills served under trafficcams.vancouver.ca
 *   and update in place approximately every 10–15 minutes.
 *
 * Output: config/cctv_sources.vancouver.json (array of canonical source items
 * consumed by server/providers/cctv/normalize.js → normalizeSourceItem).
 *
 * Usage: node scripts/build-vancouver-cctv.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_URL = 'https://trafficcams.vancouver.ca/';
const KML_URL = 'https://vanmapp1.vancouver.ca/googleKml/traffic_cameras.kml';
const PAGE_ORIGIN = 'https://trafficcams.vancouver.ca/';
// Official city boundary from the map config (m_cov_map.js `cityBoundary`).
// upperLeft.lon is the WEST edge (more negative), lowerRight.lon the EAST edge.
const CITY_BBOX = {
  lonMin: -123.27214,
  lonMax: -123.011432,
  latMin: 49.19787,
  latMax: 49.313479,
};
// Per-view azimuth of each official direction label.
const DIRECTIONS = Object.freeze({
  North: { headingDeg: 0 },
  East: { headingDeg: 90 },
  South: { headingDeg: 180 },
  West: { headingDeg: 270 },
});
const UA = 'gods-eye-view-cctv-build/1.0 (open-data contribution)';
const CONCURRENCY = 6;

/** GET text with a bounded timeout (AbortSignal.timeout crashes this Node on Windows). */
async function text(url) {
  const resp = await Promise.race([
    fetch(url, { headers: { 'User-Agent': UA } }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${url}`)), 25_000),
    ),
  ]);
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.text();
}

/** Decode the handful of entities the KML/pages use. */
function unescapeHtml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Page key (the .htm basename, lowercased) → canonical id slug. */
function pageKey(href) {
  const base = String(href || '')
    .trim()
    .split('/')
    .pop()
    .replace(/\.htm$/i, '');
  return base.toLowerCase();
}

/** Clean common city-site naming habits out of id slugs (`Foo-htm.htm`). */
function slug(key) {
  return key
    .replace(/[-_]htm$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse the KML into {pageKey, title, lat, lon, pageHref}. */
function parseKml(kml) {
  const entries = [];
  for (const block of kml.matchAll(
    /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g,
  )) {
    const raw = block[1];
    const name = /<name>([\s\S]*?)<\/name>/.exec(raw)?.[1].trim() || '';
    const coords =
      /<coordinates>([\s\S]*?)<\/coordinates>/.exec(raw)?.[1].trim() || '';
    const desc = /<description>([\s\S]*?)<\/description>/.exec(raw)?.[1] || '';
    const description = unescapeHtml(desc);
    const title = /<h5>([\s\S]*?)<\/h5>/.exec(description)?.[1].trim() || '';
    const hrefs = [
      ...description.matchAll(/<a[^>]+href=['"]([^'"]+)['"][^>]*>/gi),
    ].map((m) => m[1]);
    const pageHref =
      hrefs.find((h) => /trafficcams\.vancouver\.ca/.test(h)) || '';
    const [lon, lat] = coords.split(',').map(Number);
    if (!pageHref || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    entries.push({
      pageKey: pageKey(pageHref),
      name,
      title,
      lat,
      lon,
      pageHref,
    });
  }
  return entries;
}
/** Parse the index page into {key, label} for cross-checking coverage. */
function parseIndex(html) {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] || '';
    if (!/\.htm$/i.test(href.trim())) continue;
    const key = pageKey(href);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ key, label });
  }
  return out;
}

/** Fetch one intersection page, return its directional cameras. */
async function fetchPageCameras(page) {
  const html = await text(page.pageHref.trim());
  const cameras = [];
  const blocks = [...html.matchAll(/<div class="camera">([\s\S]*?)<\/div>/gi)];
  for (const block of blocks) {
    const inner = block[1];
    const src = /<img[^>]+src=["']([^"']+)["']/i.exec(inner)?.[1] || '';
    const alt = /<img[^>]+alt=["']([^"']*)["']/i.exec(inner)?.[1] || '';
    let direction = /-\s*(North|East|South|West)\s*$/.exec(alt.trim())?.[1];
    if (!direction) {
      // Fall back to the <strong> label when the alt text is not directional.
      const label = /<strong>([^<]*)<\/strong>/.exec(inner)?.[1].trim();
      if (DIRECTIONS[label]) direction = label;
    }
    if (!direction || !DIRECTIONS[direction]) continue;
    if (!/cameraimages\//.test(src)) continue;
    let imageUrl = src;
    if (/^\//.test(imageUrl)) {
      imageUrl = `${PAGE_ORIGIN}${imageUrl.slice(1)}`;
    } else if (!/^https?:/i.test(imageUrl)) {
      imageUrl = `${PAGE_ORIGIN}${imageUrl}`;
    }
    if (!imageUrl.startsWith(PAGE_ORIGIN)) {
      console.warn(
        `[build-vancouver-cctv] unpinned image ${imageUrl} (${page.pageKey}); skipped`,
      );
      continue;
    }
    cameras.push({
      direction,
      headingDeg: DIRECTIONS[direction].headingDeg,
      imageUrl,
    });
  }
  return cameras;
}

/** Run `fns` with a concurrency cap of `limit`. */
async function mapPool(fns, limit) {
  const results = new Array(fns.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= fns.length) return;
      results[index] = await fns[index]();
    }
  };
  const workers = Array.from({ length: Math.min(limit, fns.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
async function main() {
  console.log('[build-vancouver-cctv] fetching KML + index…');
  const [kml, indexHtml] = await Promise.all([text(KML_URL), text(INDEX_URL)]);
  const kmlEntries = parseKml(kml);
  const indexPages = parseIndex(indexHtml);
  console.log(
    `[build-vancouver-cctv] KML intersections ${kmlEntries.length}; index pages ${indexPages.length}`,
  );

  const byKey = new Map();
  for (const entry of kmlEntries) byKey.set(entry.pageKey, entry);
  const onlyIndex = indexPages.filter((p) => !byKey.has(p.key));
  if (onlyIndex.length) {
    console.warn(
      `[build-vancouver-cctv] ${onlyIndex.length} index pages have no KML coordinate: ` +
        onlyIndex
          .slice(0, 6)
          .map((p) => p.key)
          .join(', '),
    );
  }

  const results = await mapPool(
    kmlEntries.map(
      (page) => () =>
        fetchPageCameras(page)
          .then((cameras) => ({ page, cameras }))
          .catch((error) => ({
            page,
            cameras: [],
            error: error?.message || String(error),
          })),
    ),
    CONCURRENCY,
  );

  const records = [];
  for (const { page, cameras, error } of results) {
    if (error) {
      console.warn(`[build-vancouver-cctv] page ${page.pageHref} -> ${error}`);
      continue;
    }
    const lon = Number(page.lon);
    const lat = Number(page.lat);
    const inBbox =
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      lon >= CITY_BBOX.lonMin &&
      lon <= CITY_BBOX.lonMax &&
      lat >= CITY_BBOX.latMin &&
      lat <= CITY_BBOX.latMax;
    if (!inBbox) {
      console.warn(
        `[build-vancouver-cctv] out-of-bounds ${page.pageKey} ${lat},${lon}; skipped`,
      );
      continue;
    }
    for (const cam of cameras) {
      records.push({
        id: `van-${slug(page.pageKey)}-${cam.direction.toLowerCase()}`,
        name: `${page.title} — ${cam.direction}`,
        city: 'Vancouver',
        cityId: 'vancouver',
        provider: 'City of Vancouver Traffic Cams',
        sourceKind: 'vancouver-open-data',
        feedType: 'image',
        url: cam.imageUrl,
        snapshotUrl: cam.imageUrl,
        lat: round6(lat),
        lon: round6(lon),
        headingDeg: cam.headingDeg,
        headingConfidence: 'high',
        // Same fabricated-pose priors as Austin's heading-known cameras; the
        // client's one-shot ground snap + manual calibration own the truth.
        pitchDeg: -24,
        fovDeg: 56,
        rangeM: 210,
        mountHeightM: 10,
        groundElevationM: 60,
        license:
          'City of Vancouver traffic cameras — trafficcams.vancouver.ca (Terms of Use)',
      });
    }
  }

  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set();
  const unique = records.filter((record) => {
    if (seen.has(record.id)) {
      console.warn(`[build-vancouver-cctv] duplicate id ${record.id}; dropped`);
      return false;
    }
    seen.add(record.id);
    return true;
  });

  const pagesWithCameras = results.filter(
    (r) => !r.error && r.cameras.length,
  ).length;
  const totalCameras = results.reduce((sum, r) => sum + r.cameras.length, 0);
  const outPath = path.join(ROOT, 'config', 'cctv_sources.vancouver.json');
  fs.writeFileSync(outPath, `${JSON.stringify(unique, null, 2)}\n`, 'utf8');
  console.log(
    `[build-vancouver-cctv] ${pagesWithCameras}/${results.length} pages · ${totalCameras} cameras → ${unique.length} sources`,
  );
  console.log(`[build-vancouver-cctv] wrote ${path.relative(ROOT, outPath)}`);
  console.log(
    '[build-vancouver-cctv] run with: CCTV_SOURCES_FILE=config/cctv_sources.vancouver.json npm run dev',
  );
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

await main();

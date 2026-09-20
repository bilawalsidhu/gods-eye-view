#!/usr/bin/env node
/**
 * Export the world public-camera catalog as a static CCTV source pack.
 *
 * Reads the declarative catalog registry in config/cctv_catalogs.world.json
 * (one entry per national/municipal traffic-camera API: URL, field paths,
 * pagination, licence, cap), fetches every catalog, and writes
 * config/cctv_sources.world.json in this repo's source-pack schema (the
 * shape normalizeSourceItem() in server/providers/cctv/normalize.js accepts).
 * Point CCTV_SOURCES_FILE at the output to serve it; set CCTV_FORCE_AUSTIN=1
 * to keep the built-in live packs alongside it.
 *
 * The registry format and the catalog-walking logic below (parseXmlRecords,
 * pluckPath, applyUrlTemplate, parseWktPoint, fetchWorldCatalogRows, and the
 * row -> camera mapping) are vendored from the world-catalog adapter in
 * uhrichsam4/gods-eye-view (https://github.com/uhrichsam4/gods-eye-view,
 * MIT License, vite.config.js `loadWorldCatalogSources`). Shared helpers
 * (toFiniteNumber, fallbackHeadingFromId, prioritizeSources,
 * directionToHeading) are imported from this repo instead of re-vendored.
 *
 * Usage:
 *   node scripts/export-world-cctv.mjs
 *   node scripts/export-world-cctv.mjs --only fi-digitraffic,no-vegvesen,se
 *   node scripts/export-world-cctv.mjs --max-per-catalog 120
 *
 * Options:
 *   --only <ids>            comma-separated catalog ids and/or country codes
 *                           (also re-enables a registry entry with enabled:false)
 *   --max-per-catalog <N>   cap per catalog; overrides each entry's maxSources
 *                           (0 = no cap)
 *   --catalogs <path>       registry file (default config/cctv_catalogs.world.json)
 *   --out <path>            output pack (default config/cctv_sources.world.json)
 *   --concurrency <N>       catalogs fetched in parallel (default 6)
 *   --timeout <ms>          per-request timeout (default 15000)
 *
 * Catalogs fail independently: a failed catalog is logged and skipped, and the
 * script exits 0 as long as at least one camera was exported.
 */
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './project-root.mjs';
import {
  toFiniteNumber,
  fallbackHeadingFromId,
  prioritizeSources,
} from '../server/providers/cctv/normalize.js';
import { directionToHeading } from '../src/data/directionText.js';

const ROOT = projectRoot(import.meta.url);
const DEFAULT_CATALOG_FILE = 'config/cctv_catalogs.world.json';
const DEFAULT_OUTPUT_FILE = 'config/cctv_sources.world.json';
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 15 * 1000;
/** Whole-catalog budget, so a slow paginated endpoint cannot stall the run. */
const CATALOG_BUDGET_MS = 120 * 1000;
/** DataTables-style catalogs hard-cap page size at 100 regardless of what is asked. */
const DATATABLES_PAGE_SIZE = 100;
/** Backstop against an upstream recordsTotal blow-up. */
const MAX_PAGES = 60;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const options = {
    only: [],
    maxPerCatalog: null,
    catalogs: DEFAULT_CATALOG_FILE,
    out: DEFAULT_OUTPUT_FILE,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--only') {
      options.only = next()
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === '--max-per-catalog') {
      const value = Number(next());
      if (!Number.isFinite(value) || value < 0)
        throw new Error('--max-per-catalog must be a non-negative number');
      options.maxPerCatalog = Math.floor(value);
    } else if (arg === '--catalogs') {
      options.catalogs = next();
    } else if (arg === '--out') {
      options.out = next();
    } else if (arg === '--concurrency') {
      options.concurrency = Math.max(1, Math.floor(Number(next())) || 1);
    } else if (arg === '--timeout') {
      options.timeoutMs = Math.max(1000, Math.floor(Number(next())) || 0);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  const header = fs
    .readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n')
    .slice(1)
    .join('\n')
    .split('*/')[0];
  console.log(header.replace(/^\s*\*? ?/gm, ''));
}

// ---------------------------------------------------------------------------
// Vendored catalog-walking helpers (uhrichsam4/gods-eye-view, MIT)
// ---------------------------------------------------------------------------
/**
 * Parse a WKT POINT string ("POINT(lon lat)") into {lat, lon}, or null.
 */
function parseWktPoint(wkt) {
  const match = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(
    String(wkt || ''),
  );
  if (!match) return null;
  const lon = toFiniteNumber(match[1], NaN);
  const lat = toFiniteNumber(match[2], NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Minimal XML record extractor. Deliberately not a general XML parser: the
 * catalogs that ship XML are flat lists of one record tag whose children are
 * leaf text nodes (Hong Kong's <image>, Madrid's <camara>). Handles CDATA and
 * the five predefined entities; repeated child tags keep the FIRST occurrence.
 */
function parseXmlRecords(xml, recordTag) {
  const safeTag = String(recordTag).replace(/[^A-Za-z0-9_:.-]/g, '');
  if (!safeTag) return [];
  const records = [];
  const recordPattern = new RegExp(
    `<${safeTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${safeTag}>`,
    'g',
  );
  const decode = (raw) =>
    String(raw)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim();

  let match = recordPattern.exec(xml);
  while (match) {
    const body = match[1];
    const record = {};
    // Recurse into nested elements (Madrid wraps coordinates in <Posicion>).
    const collect = (fragment) => {
      const fieldPattern = /<([A-Za-z0-9_:.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
      let field = fieldPattern.exec(fragment);
      while (field) {
        const [, tag, value] = field;
        if (/<[A-Za-z]/.test(value)) collect(value);
        else if (!(tag in record)) record[tag] = decode(value);
        field = fieldPattern.exec(fragment);
      }
    };
    collect(body);
    if (Object.keys(record).length) records.push(record);
    match = recordPattern.exec(xml);
  }
  return records;
}

/** Read a dotted path ("geometry.coordinates.1") out of a record. */
function pluckPath(source, dotted) {
  if (!dotted) return undefined;
  let cursor = source;
  for (const segment of String(dotted).split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Substitute {field} placeholders in a URL template (values URI-encoded). */
function applyUrlTemplate(template, record, fields) {
  return String(template).replace(/\{(\w+)\}/g, (_match, key) => {
    const raw = pluckPath(record, fields?.[key] || key);
    return encodeURIComponent(
      raw === undefined || raw === null ? '' : String(raw),
    );
  });
}

/**
 * Fetch every row of one catalog, following its pagination mode
 * (none = one request; 'datatables' = the 511-family POST endpoint, 100/page).
 */
async function fetchWorldCatalogRows(catalog, timeoutMs) {
  const requestOnce = async (extraBody) => {
    const init = {
      method: catalog.method === 'POST' ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-cctv-export/1.0',
        ...(catalog.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (init.method === 'POST') {
      init.headers['Content-Type'] =
        catalog.contentType || 'application/x-www-form-urlencoded';
      init.body = extraBody ?? catalog.body ?? '';
    }
    const resp = await fetch(catalog.catalogUrl, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text.trim()) throw new Error('empty body');
    if (catalog.format === 'xml')
      return parseXmlRecords(text, catalog.recordTag || 'item');
    return JSON.parse(text);
  };

  const pagination = catalog.pagination;
  if (!pagination || pagination.mode !== 'datatables') {
    const payload = await requestOnce();
    // parseXmlRecords already returns the flat record array; arrayPath is a
    // JSON-only concept.
    const rows =
      catalog.format !== 'xml' && catalog.arrayPath
        ? pluckPath(payload, catalog.arrayPath)
        : payload;
    return Array.isArray(rows) ? rows : [];
  }

  // DataTables: page 0 first for the total, then the rest sequentially. These
  // endpoints intermittently answer 200 with an empty body, so retry each page.
  const pageBody = (start) =>
    String(catalog.body || '').replace(/(^|&)start=\d+/, `$1start=${start}`);
  const fetchPage = async (start) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await requestOnce(pageBody(start));
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, 400 * (attempt + 1)),
        );
      }
    }
    return null;
  };

  const first = await fetchPage(0);
  const rowsOf = (payload) => {
    const rows = catalog.arrayPath
      ? pluckPath(payload, catalog.arrayPath)
      : payload;
    return Array.isArray(rows) ? rows : [];
  };
  const all = [...rowsOf(first)];
  const total = toFiniteNumber(
    pluckPath(first, pagination.totalPath || 'recordsTotal'),
    all.length,
  );
  const pageCount = Math.min(
    Math.ceil(total / DATATABLES_PAGE_SIZE) || 1,
    MAX_PAGES,
  );
  for (let page = 1; page < pageCount; page += 1) {
    const payload = await fetchPage(page * DATATABLES_PAGE_SIZE);
    all.push(...rowsOf(payload));
  }
  return all;
}

/**
 * Map one raw catalog row to a source-pack camera, or null when the row has
 * no usable position or image URL.
 */
function rowToCamera(catalog, row) {
  const fields = catalog.fields || {};
  // Two coordinate encodings in the wild: discrete lat/lon fields, and a WKT
  // POINT string (the 511 DataTables family). `fields.wkt` selects the latter.
  let lat = NaN;
  let lon = NaN;
  if (fields.wkt) {
    const point = parseWktPoint(pluckPath(row, fields.wkt));
    if (point) {
      lat = point.lat;
      lon = point.lon;
    }
  } else {
    lat = toFiniteNumber(pluckPath(row, fields.lat), NaN);
    lon = toFiniteNumber(pluckPath(row, fields.lon), NaN);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // Unplaced cameras reported as 0,0 would land in the Gulf of Guinea.
  if (lat === 0 && lon === 0) return null;

  let imageUrl = '';
  if (catalog.imageUrlTemplate) {
    imageUrl = applyUrlTemplate(catalog.imageUrlTemplate, row, fields);
  } else {
    const raw = pluckPath(row, fields.imageUrl);
    if (typeof raw === 'string') imageUrl = raw;
  }
  // Some agencies wrap the URL in HTML ('<a href="...">Camera 38</a>').
  if (imageUrl && catalog.imageUrlRegex) {
    const match = new RegExp(catalog.imageUrlRegex).exec(imageUrl);
    imageUrl = match ? (match[1] ?? match[0]) : '';
  }
  // Protocol-relative values with trailing whitespace exist in the wild.
  imageUrl = imageUrl.trim();
  if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
  if (!imageUrl) return null;
  // Relative image paths come rooted ('/images/1.jpg') and bare
  // ('94/94_2026.jpg'); resolve either against imageBaseUrl.
  if (catalog.imageBaseUrl && !/^https?:\/\//i.test(imageUrl)) {
    const base = String(catalog.imageBaseUrl).replace(/\/+$/, '');
    imageUrl = `${base}/${imageUrl.replace(/^\/+/, '')}`;
  }
  // Raw spaces in filenames are rejected by several HTTP clients.
  imageUrl = imageUrl.replace(/ /g, '%20');
  // Upgrade http:// so an https page can load the frame without mixed content.
  if (imageUrl.startsWith('http://')) imageUrl = `https://${imageUrl.slice(7)}`;
  if (!/^https?:\/\//i.test(imageUrl)) return null;
  // Some layers aggregate several agencies and only part is reachable;
  // imageUrlPrefix keeps the dependable subset.
  if (
    catalog.imageUrlPrefix &&
    !imageUrl
      .toLowerCase()
      .startsWith(String(catalog.imageUrlPrefix).toLowerCase())
  )
    return null;

  const rawId = pluckPath(row, fields.id);
  const localId = String(rawId ?? `${lat.toFixed(5)},${lon.toFixed(5)}`).trim();
  if (!localId) return null;

  const heading = directionToHeading(pluckPath(row, fields.heading), true);
  const hasHeading = Number.isFinite(heading);
  const elevation = toFiniteNumber(pluckPath(row, fields.elevation), NaN);
  const cameraId = `${catalog.id}-${localId}`;

  return {
    id: cameraId,
    name: String(pluckPath(row, fields.name) ?? localId).trim() || localId,
    city: String(catalog.countryName || catalog.country || 'World'),
    cityId: String(catalog.id),
    provider: String(catalog.provider || catalog.id),
    lat,
    lon,
    headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
    headingConfidence: hasHeading ? 'high' : 'low',
    pitchDeg: hasHeading ? -22 : -18,
    fovDeg: hasHeading ? 56 : 44,
    rangeM: hasHeading ? 220 : 145,
    mountHeightM: hasHeading ? 9 : 8,
    groundElevationM: Number.isFinite(elevation)
      ? Math.max(-100, Math.min(4000, elevation))
      : 50,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: `world-${catalog.id}`,
    license: String(catalog.license || 'Licence not published by the operator'),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function withBudget(promise, ms, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms / 1000}s budget`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function exportCatalog(catalog, options) {
  const startedAt = Date.now();
  const result = {
    id: catalog.id,
    country: catalog.countryName || catalog.country || '',
    rows: 0,
    usable: 0,
    kept: 0,
    cameras: [],
    error: null,
    ms: 0,
  };
  try {
    const rows = await withBudget(
      fetchWorldCatalogRows(catalog, options.timeoutMs),
      CATALOG_BUDGET_MS,
      catalog.id,
    );
    result.rows = rows.length;
    const cameras = [];
    for (const row of rows) {
      const camera = rowToCamera(catalog, row);
      if (camera) cameras.push(camera);
    }
    result.usable = cameras.length;
    if (!cameras.length) throw new Error('no usable rows');

    const anchors =
      Array.isArray(catalog.anchors) && catalog.anchors.length
        ? catalog.anchors
        : [{ lat: cameras[0].lat, lon: cameras[0].lon }];
    const cap =
      options.maxPerCatalog !== null
        ? options.maxPerCatalog
        : Number.isFinite(catalog.maxSources)
          ? catalog.maxSources
          : 0;
    result.cameras = prioritizeSources(cameras, cap, anchors);
    result.kept = result.cameras.length;
  } catch (err) {
    result.error = err?.cause?.message || err?.message || String(err);
  }
  result.ms = Date.now() - startedAt;
  return result;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

function selectCatalogs(registry, only) {
  return registry.filter((catalog) => {
    if (!catalog || !catalog.id) return false;
    if (!only.length) return catalog.enabled !== false;
    // An explicit --only re-enables a registry entry with enabled:false.
    return (
      only.includes(String(catalog.id).toLowerCase()) ||
      only.includes(String(catalog.country).toLowerCase())
    );
  });
}

function printTable(results) {
  const rows = results.map((r) => [
    r.id,
    r.country,
    String(r.rows),
    String(r.usable),
    String(r.kept),
    `${(r.ms / 1000).toFixed(1)}s`,
    r.error ? `FAILED: ${r.error}` : 'ok',
  ]);
  const head = [
    'catalog',
    'region',
    'rows',
    'usable',
    'kept',
    'time',
    'status',
  ];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  // Status is last and free-form, so it never needs padding.
  const line = (cells) =>
    cells
      .map((cell, i) =>
        i === cells.length - 1
          ? cell
          : i >= 2 && i <= 5
            ? cell.padStart(widths[i])
            : cell.padEnd(widths[i]),
      )
      .join('  ');
  console.log('');
  console.log(line(head));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(row));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (options.help) {
    printHelp();
    return;
  }

  const catalogPath = path.resolve(ROOT, options.catalogs);
  const outputPath = path.resolve(ROOT, options.out);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    console.error(
      `Cannot read catalog registry ${catalogPath}: ${err.message}`,
    );
    process.exit(1);
  }
  if (!Array.isArray(registry)) {
    console.error(`Catalog registry ${catalogPath} must be a JSON array`);
    process.exit(1);
  }

  const active = selectCatalogs(registry, options.only);
  const skipped = registry.filter((c) => c && c.id && !active.includes(c));
  if (!active.length) {
    console.error(
      'No catalogs selected (check --only against the registry ids)',
    );
    process.exit(1);
  }
  console.log(
    `Fetching ${active.length} of ${registry.length} catalogs from ${path.relative(ROOT, catalogPath)} ` +
      `(concurrency ${options.concurrency}, timeout ${options.timeoutMs / 1000}s` +
      (options.maxPerCatalog !== null
        ? `, max ${options.maxPerCatalog || 'unlimited'} per catalog)`
        : ', per-catalog maxSources from the registry)'),
  );
  for (const catalog of active) {
    if (catalog.enabled === false)
      console.warn(
        `[warn] ${catalog.id} is disabled in the registry and was re-enabled by --only` +
          (catalog.note ? ` -- ${catalog.note}` : ''),
      );
  }

  const results = await runPool(
    active,
    options.concurrency,
    async (catalog) => {
      const result = await exportCatalog(catalog, options);
      if (result.error) console.warn(`[fail] ${catalog.id}: ${result.error}`);
      else
        console.log(
          `[ok]   ${catalog.id}: ${result.kept} cameras (${result.usable} usable of ${result.rows} rows)`,
        );
      return result;
    },
  );

  // Merge in registry order; the first occurrence of an id wins.
  const seen = new Set();
  const cameras = [];
  for (const result of results) {
    for (const camera of result.cameras) {
      if (seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
  }

  printTable(results);
  const failed = results.filter((r) => r.error);
  const succeeded = results.length - failed.length;
  console.log('');
  console.log(
    `Total: ${cameras.length} cameras from ${succeeded} catalogs` +
      (failed.length
        ? `; ${failed.length} failed (${failed.map((r) => r.id).join(', ')})`
        : '') +
      (skipped.length
        ? `; ${skipped.length} not selected (${skipped.map((c) => c.id).join(', ')})`
        : ''),
  );

  if (!cameras.length) {
    console.error(
      `No cameras exported; leaving ${path.relative(ROOT, outputPath)} untouched.`,
    );
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(cameras, null, 2)}\n`, 'utf8');
  const bytes = fs.statSync(outputPath).size;
  console.log(
    `Wrote ${path.relative(ROOT, outputPath)} (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
  );
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});

import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readResponseJsonCapped } from './common/http.js';
import { fetchOverpassPayload } from './overpass/transport.js';

const SITE_CAP = 1000;
const OPEN_CELL_ID_LIMIT = 50;
const MAX_VIEWPORT_DEGREES = 2;
const OPEN_CELL_ID_TILE_DEGREES = 0.016;
const OPEN_CELL_ID_MAX_AREA_M2 = 3_500_000;
const OPEN_CELL_ID_FULL_TILE_BUDGET = 36;
const OPEN_CELL_ID_OVERVIEW_TILE_BUDGET = 12;
const OPEN_CELL_ID_TILE_CONCURRENCY = 3;
const SITE_CACHE_GRID_DEGREES = 0.05;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SITE_CACHE_TTL_MS = 30 * 60 * 1000;
const CELL_TILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OPEN_CELL_ID_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const RESPONSE_LIMIT_BYTES = 768 * 1024;
const RADIO_VALUES = new Set(['GSM', 'UMTS', 'LTE', 'NR', 'NBIOT', 'CDMA']);

const cache = new Map();
const tileCache = new Map();
const siteCache = new Map();
const limiter = makeRateLimiter({ windowMs: 60_000, max: 80, globalMax: 240 });
let openCellIdRateLimitedUntil = 0;

function finiteParam(params, key) {
  const value = Number(params.get(key));
  return Number.isFinite(value) ? value : null;
}

export function validCellularBox(params) {
  const south = finiteParam(params, 'south');
  const west = finiteParam(params, 'west');
  const north = finiteParam(params, 'north');
  const east = finiteParam(params, 'east');
  if (
    [south, west, north, east].some((value) => value === null) ||
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180 ||
    north <= south ||
    east <= west ||
    north - south > MAX_VIEWPORT_DEGREES ||
    east - west > MAX_VIEWPORT_DEGREES
  )
    return null;
  return { south, west, north, east };
}

export function cellularBoxAreaM2(box) {
  if (!box) return Infinity;
  const midLat = ((box.south + box.north) / 2) * (Math.PI / 180);
  const height = (box.north - box.south) * 111_320;
  const width =
    (box.east - box.west) * 111_320 * Math.max(0.01, Math.cos(midLat));
  return Math.max(0, width * height);
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

export function planOpenCellIdTiles(
  box,
  maxTiles = OPEN_CELL_ID_FULL_TILE_BUDGET,
) {
  if (!box) return { tiles: [], totalTiles: 0, exceedsLimit: false };
  const latStart = Math.floor((box.south + 90) / OPEN_CELL_ID_TILE_DEGREES);
  const latEnd = Math.ceil((box.north + 90) / OPEN_CELL_ID_TILE_DEGREES) - 1;
  const lonStart = Math.floor((box.west + 180) / OPEN_CELL_ID_TILE_DEGREES);
  const lonEnd = Math.ceil((box.east + 180) / OPEN_CELL_ID_TILE_DEGREES) - 1;
  const rows = Math.max(0, latEnd - latStart + 1);
  const columns = Math.max(0, lonEnd - lonStart + 1);
  const totalTiles = rows * columns;
  if (!totalTiles) return { tiles: [], totalTiles: 0, exceedsLimit: false };

  const tiles = [];
  for (let latIndex = latStart; latIndex <= latEnd; latIndex += 1) {
    const south = -90 + latIndex * OPEN_CELL_ID_TILE_DEGREES;
    const north = Math.min(90, south + OPEN_CELL_ID_TILE_DEGREES);
    for (let lonIndex = lonStart; lonIndex <= lonEnd; lonIndex += 1) {
      const west = -180 + lonIndex * OPEN_CELL_ID_TILE_DEGREES;
      const east = Math.min(180, west + OPEN_CELL_ID_TILE_DEGREES);
      const tile = {
        id: `${latIndex}:${lonIndex}`,
        south: roundCoordinate(south),
        west: roundCoordinate(west),
        north: roundCoordinate(north),
        east: roundCoordinate(east),
      };
      if (cellularBoxAreaM2(tile) <= OPEN_CELL_ID_MAX_AREA_M2) tiles.push(tile);
    }
  }

  const exceedsLimit = tiles.length > maxTiles;
  if (!exceedsLimit) return { tiles, totalTiles, exceedsLimit: false };

  const centerLat = (box.south + box.north) / 2;
  const centerLon = (box.west + box.east) / 2;
  tiles.sort((a, b) => {
    const aLat = (a.south + a.north) / 2 - centerLat;
    const aLon = (a.west + a.east) / 2 - centerLon;
    const bLat = (b.south + b.north) / 2 - centerLat;
    const bLon = (b.west + b.east) / 2 - centerLon;
    return aLat * aLat + aLon * aLon - (bLat * bLat + bLon * bLon);
  });
  return {
    tiles: tiles.slice(0, Math.max(1, maxTiles)),
    totalTiles,
    exceedsLimit: true,
  };
}

export function planOpenCellIdRequest(box) {
  const fullPlan = planOpenCellIdTiles(box, OPEN_CELL_ID_FULL_TILE_BUDGET);
  const viewportPartial = fullPlan.exceedsLimit;
  const tileLimit = viewportPartial
    ? OPEN_CELL_ID_OVERVIEW_TILE_BUDGET
    : OPEN_CELL_ID_FULL_TILE_BUDGET;
  return {
    ...fullPlan,
    tiles: viewportPartial
      ? fullPlan.tiles.slice(0, OPEN_CELL_ID_OVERVIEW_TILE_BUDGET)
      : fullPlan.tiles,
    tileLimit,
    viewportPartial,
  };
}

function cacheKey(box, radio, part = 'all') {
  const hasOpenCellIdKey = Boolean(
    String(process.env.OPENCELLID_API_KEY || '').trim(),
  );
  const backend = hasOpenCellIdKey ? 'live' : 'sites-only';
  return (
    [box.south, box.west, box.north, box.east]
      .map((value) => Number(value).toFixed(4))
      .join(':') + `:${radio}:${part}:${backend}`
  );
}

function quantizedSiteBox(box) {
  const step = SITE_CACHE_GRID_DEGREES;
  return {
    south: Math.max(-90, Math.floor(box.south / step) * step),
    west: Math.max(-180, Math.floor(box.west / step) * step),
    north: Math.min(90, Math.ceil(box.north / step) * step),
    east: Math.min(180, Math.ceil(box.east / step) * step),
  };
}

function siteCacheKey(box) {
  return [box.south, box.west, box.north, box.east]
    .map((value) => Number(value).toFixed(3))
    .join(':');
}

function elementCoordinates(element) {
  const lat = Number(element?.lat ?? element?.center?.lat);
  const lon = Number(element?.lon ?? element?.center?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function elementInsideBox(element, box) {
  const point = elementCoordinates(element);
  return (
    point &&
    point.lat >= box.south &&
    point.lat <= box.north &&
    point.lon >= box.west &&
    point.lon <= box.east
  );
}

function readTimedCache(store, key, ttlMs) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) {
    store.delete(key);
    return null;
  }
  return entry.payload;
}

function writeTimedCache(store, key, payload, maxEntries, pruneCount) {
  store.set(key, { at: Date.now(), payload });
  if (store.size <= maxEntries) return;
  const oldest = [...store.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, pruneCount);
  for (const [entryKey] of oldest) store.delete(entryKey);
}

function readCache(key) {
  return readTimedCache(cache, key, CACHE_TTL_MS);
}

function writeCache(key, payload) {
  writeTimedCache(cache, key, payload, 120, 30);
}

function tileCacheKey(tile, radio) {
  return `${tile.id}:${radio}`;
}

function readTileCache(key) {
  return readTimedCache(tileCache, key, CELL_TILE_CACHE_TTL_MS);
}

function writeTileCache(key, payload) {
  writeTimedCache(tileCache, key, payload, 1500, 250);
}

async function fetchMappedSites(box) {
  const queryBox = quantizedSiteBox(box);
  const key = siteCacheKey(queryBox);
  let cached = readTimedCache(siteCache, key, SITE_CACHE_TTL_MS);
  if (!cached) {
    const bbox = `${queryBox.south},${queryBox.west},${queryBox.north},${queryBox.east}`;
    // communication:mobile_phone=* is the de-facto OSM discriminator for
    // physical structures carrying cellular equipment. Keep the query specific:
    // generic communications towers may be broadcast/microwave only.
    const ql = `[out:json][timeout:18];(nwr["communication:mobile_phone"](${bbox});nwr["communication"="mobile_phone"](${bbox}););out center tags ${SITE_CAP};`;
    const upstream = await fetchOverpassPayload(
      `data=${encodeURIComponent(ql)}`,
      RESPONSE_LIMIT_BYTES,
    );
    if (upstream.status >= 400 || upstream.rateLimited || upstream.runtimeError)
      throw new Error('OpenStreetMap cellular-site query unavailable');
    const parsed = JSON.parse(upstream.body);
    const elements = Array.isArray(parsed?.elements)
      ? parsed.elements
          .filter((element) => {
            const tags = element?.tags || {};
            if (
              String(tags.communication || '').toLowerCase() === 'mobile_phone'
            )
              return true;
            const mobile = String(tags['communication:mobile_phone'] || '')
              .trim()
              .toLowerCase();
            return Boolean(mobile) && !['no', 'false', '0'].includes(mobile);
          })
          .slice(0, SITE_CAP)
      : [];
    cached = {
      elements,
      siteSaturated: elements.length >= SITE_CAP,
    };
    writeTimedCache(siteCache, key, cached, 200, 40);
  }

  const elements = cached.elements.filter((element) =>
    elementInsideBox(element, box),
  );
  return {
    elements,
    siteSaturated: cached.siteSaturated,
    sitesStatus: elements.length ? 'ready' : 'empty',
  };
}

function openCellIdErrorCode(payload) {
  const value = Number(
    payload?.err?.code ?? payload?.error?.code ?? payload?.code,
  );
  return Number.isFinite(value) ? value : null;
}

function openCellIdFailureStatus(response, payload, error) {
  const code = openCellIdErrorCode(payload);
  if (response?.status === 401 || code === 2) return 'invalid-key';
  if (response?.status === 429 || code === 7) return 'rate-limited';
  if (response?.status === 400 || code === 3) return 'invalid-request';
  if (error?.name === 'AbortError') return 'timeout';
  return 'unavailable';
}

async function fetchOpenCellIdTile(tile, radio) {
  const cached = readTileCache(tileCacheKey(tile, radio));
  if (cached) return { ...cached, cached: true };

  const key = String(process.env.OPENCELLID_API_KEY || '').trim();
  const query = new URLSearchParams({
    key,
    BBOX: `${tile.south},${tile.west},${tile.north},${tile.east}`,
    format: 'json',
    limit: String(OPEN_CELL_ID_LIMIT),
  });
  if (radio !== 'ALL') query.set('radio', radio);

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 9_000);
  try {
    const response = await fetch(
      `https://opencellid.org/cell/getInArea?${query}`,
      {
        signal: abort.signal,
        headers: { Accept: 'application/json' },
      },
    );
    const payload = await readResponseJsonCapped(
      response,
      RESPONSE_LIMIT_BYTES,
      abort.signal,
    );
    if (
      !response.ok ||
      payload?.err ||
      payload?.error ||
      !Array.isArray(payload?.cells)
    ) {
      return {
        cells: [],
        status: openCellIdFailureStatus(response, payload),
        saturated: false,
        cached: false,
      };
    }
    const cells = payload.cells.slice(0, OPEN_CELL_ID_LIMIT);
    const result = {
      cells,
      status: cells.length ? 'ready' : 'empty',
      saturated: cells.length >= OPEN_CELL_ID_LIMIT,
      cached: false,
    };
    writeTileCache(tileCacheKey(tile, radio), result);
    return result;
  } catch (error) {
    return {
      cells: [],
      status: openCellIdFailureStatus(null, null, error),
      saturated: false,
      cached: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function cellIdentity(cell) {
  const radio =
    String(cell?.radio || '')
      .trim()
      .toUpperCase() || 'UNKNOWN';
  const mcc = Number(cell?.mcc);
  const mnc = Number(cell?.mnc);
  const tac = Number(cell?.tac);
  const lac = Number(cell?.lac);
  const cellId = Number(cell?.cellid);
  const area =
    Number.isFinite(tac) && tac > 0 ? tac : Number.isFinite(lac) ? lac : 'na';
  return `${radio}:${mcc}:${mnc}:${area}:${cellId}`;
}

function cellInsideBox(cell, box) {
  const lat = Number(cell?.lat);
  const lon = Number(cell?.lon);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= box.south &&
    lat <= box.north &&
    lon >= box.west &&
    lon <= box.east
  );
}

async function fetchOpenCellId(box, radio) {
  const key = String(process.env.OPENCELLID_API_KEY || '').trim();
  const areaM2 = cellularBoxAreaM2(box);
  const cellAreaKm2 = Math.round((areaM2 / 1_000_000) * 100) / 100;
  if (!key)
    return {
      cells: [],
      cellStatus: 'key-required',
      cellSaturated: false,
      cellAreaKm2,
      cellTileCount: 0,
      cellTilesQueried: 0,
      cellCachedTiles: 0,
      cellFailedTiles: 0,
      cellSaturatedTiles: 0,
      cellTileLimit: OPEN_CELL_ID_FULL_TILE_BUDGET,
      cellViewportPartial: false,
    };

  const plan = planOpenCellIdRequest(box);

  if (Date.now() < openCellIdRateLimitedUntil)
    return {
      cells: [],
      cellStatus: 'rate-limited',
      cellSaturated: false,
      cellAreaKm2,
      cellTileCount: plan.totalTiles,
      cellTilesQueried: 0,
      cellCachedTiles: 0,
      cellFailedTiles: 0,
      cellSaturatedTiles: 0,
      cellTileLimit: plan.tileLimit,
      cellViewportPartial: plan.viewportPartial,
    };

  const results = [];
  let terminalStatus = null;
  for (
    let offset = 0;
    offset < plan.tiles.length;
    offset += OPEN_CELL_ID_TILE_CONCURRENCY
  ) {
    const batch = plan.tiles.slice(
      offset,
      offset + OPEN_CELL_ID_TILE_CONCURRENCY,
    );
    const batchResults = await Promise.all(
      batch.map(async (tile) => ({
        tile,
        result: await fetchOpenCellIdTile(tile, radio),
      })),
    );
    results.push(...batchResults);
    terminalStatus = batchResults.find(({ result }) =>
      ['invalid-key', 'rate-limited'].includes(result.status),
    )?.result.status;
    if (terminalStatus === 'rate-limited')
      openCellIdRateLimitedUntil = Math.max(
        openCellIdRateLimitedUntil,
        Date.now() + OPEN_CELL_ID_RATE_LIMIT_COOLDOWN_MS,
      );
    if (terminalStatus) break;
  }

  const cellsById = new Map();
  let cellCachedTiles = 0;
  let cellFailedTiles = 0;
  let cellSaturatedTiles = 0;
  for (const { result } of results) {
    if (result.cached) cellCachedTiles += 1;
    if (!['ready', 'empty'].includes(result.status)) cellFailedTiles += 1;
    if (result.saturated) cellSaturatedTiles += 1;
    for (const cell of result.cells) {
      if (!cellInsideBox(cell, box)) continue;
      cellsById.set(cellIdentity(cell), cell);
    }
  }
  const cells = [...cellsById.values()];
  let cellStatus;
  if (terminalStatus && !cells.length) cellStatus = terminalStatus;
  else if (cellFailedTiles > 0)
    cellStatus = cells.length ? 'partial' : 'unavailable';
  else if (plan.viewportPartial) cellStatus = 'partial';
  else cellStatus = cells.length ? 'ready' : 'empty';

  return {
    cells,
    cellStatus,
    cellSaturated: cellSaturatedTiles > 0,
    cellAreaKm2,
    cellTileCount: plan.totalTiles,
    cellTilesQueried: results.length,
    cellCachedTiles,
    cellFailedTiles,
    cellSaturatedTiles,
    cellTileLimit: plan.tileLimit,
    cellViewportPartial: plan.viewportPartial,
  };
}

function shouldCachePayload(part, payload) {
  const sitesCacheable = ['ready', 'empty', 'not-requested'].includes(
    payload?.sitesStatus,
  );
  const cellsCacheable =
    ['ready', 'empty', 'partial', 'not-requested', 'key-required'].includes(
      payload?.cellStatus,
    ) && Number(payload?.cellFailedTiles || 0) === 0;
  if (part === 'sites') return sitesCacheable;
  if (part === 'cells') return cellsCacheable;
  return sitesCacheable && cellsCacheable;
}

export function cellularNetworksProxy() {
  const emptySites = () => ({
    elements: [],
    siteSaturated: false,
    sitesStatus: 'not-requested',
  });
  const emptyCells = () => ({
    cells: [],
    cellStatus: 'not-requested',
    cellSaturated: false,
    cellAreaKm2: null,
    cellTileCount: 0,
    cellTilesQueried: 0,
    cellCachedTiles: 0,
    cellFailedTiles: 0,
    cellSaturatedTiles: 0,
    cellTileLimit: OPEN_CELL_ID_FULL_TILE_BUDGET,
    cellViewportPartial: false,
  });

  async function buildPayload(box, radio, part) {
    if (part === 'sites') {
      const sites = await fetchMappedSites(box).catch(() => ({
        elements: [],
        siteSaturated: false,
        sitesStatus: 'unavailable',
      }));
      return {
        ...sites,
        ...emptyCells(),
        retrievedAt: new Date().toISOString(),
      };
    }
    if (part === 'cells') {
      const cells = await fetchOpenCellId(box, radio).catch(() => ({
        ...emptyCells(),
        cellStatus: 'unavailable',
      }));
      return {
        ...emptySites(),
        ...cells,
        retrievedAt: new Date().toISOString(),
      };
    }

    const [sitesResult, cellsResult] = await Promise.allSettled([
      fetchMappedSites(box),
      fetchOpenCellId(box, radio),
    ]);
    const sites =
      sitesResult.status === 'fulfilled'
        ? sitesResult.value
        : { elements: [], siteSaturated: false, sitesStatus: 'unavailable' };
    const cells =
      cellsResult.status === 'fulfilled'
        ? cellsResult.value
        : { ...emptyCells(), cellStatus: 'unavailable' };
    return {
      ...sites,
      ...cells,
      retrievedAt: new Date().toISOString(),
    };
  }

  function install(middlewares) {
    middlewares.use('/api/cellular-networks', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!limiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '5',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const box = validCellularBox(url.searchParams);
      if (!box) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'A non-dateline cellular bbox no larger than 2 degrees is required',
          }),
        );
        return;
      }
      const requestedRadio = String(
        url.searchParams.get('radio') || 'ALL',
      ).toUpperCase();
      const radio =
        requestedRadio === 'ALL' || RADIO_VALUES.has(requestedRadio)
          ? requestedRadio
          : null;
      if (!radio) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'Unsupported cellular technology filter' }),
        );
        return;
      }
      const requestedPart = String(
        url.searchParams.get('part') || 'all',
      ).toLowerCase();
      const part = ['all', 'sites', 'cells'].includes(requestedPart)
        ? requestedPart
        : null;
      if (!part) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'Unsupported cellular response part' }),
        );
        return;
      }

      const key = cacheKey(box, radio, part);
      const cached = readCache(key);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=20',
          'X-Cellular-Networks': 'HIT',
        });
        res.end(JSON.stringify(cached));
        return;
      }
      try {
        const payload = await buildPayload(box, radio, part);
        if (shouldCachePayload(part, payload)) writeCache(key, payload);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=20',
          'X-Cellular-Networks': 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch (error) {
        console.warn('[Cellular Networks]', error?.message || error);
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Cellular network providers are temporarily unavailable',
          }),
        );
      }
    });
  }

  return {
    name: 'cellular-networks-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

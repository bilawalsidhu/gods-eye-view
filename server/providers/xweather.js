import path from 'node:path';

import { readResponseBytesCapped } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import {
  observationTime,
  weatherImageBbox,
  weatherTileBounds,
} from './weather.js';
import {
  createXweatherBudget,
  XWEATHER_FREE_MONTHLY_UNITS,
} from './xweather/budget.js';
import {
  listFrames,
  resolveFrame,
  xweatherRefused,
} from './xweather/frames.js';
import { createUpstreamGate } from './xweather/gate.js';
import { makeUnitLimiter } from './xweather/limit.js';
import {
  MERCATOR_MAX_LAT,
  chooseMercatorZoom,
  reprojectToGeographic,
} from './xweather/mercator.js';
import { decodePng, encodePng, encodePngAsync } from './xweather/png.js';

/*
 * Vaisala Xweather global radar and lightning, served in the contract the
 * weather renderer already reads from `/api/weather` (`describe()` there).
 *
 * - Products: `radar-global` and `lightning-flash`, both billed at one unit
 *   per tile. `lightning-strikes` and `lightning-all` cost ten and are left
 *   out.
 * - Projection: Xweather serves Web Mercator only, so source tiles are
 *   reprojected to the geographic grid the weather shells draw, and coverage
 *   stops at ±85.0511°.
 * - Frame times come from Xweather's redirect (`x-cost-tokens: 0`) from
 *   `current` or an absolute stamp to the canonical `{valid}_{run}.png`, so
 *   manifests list exact observation times. Lookups cost no map units
 *   (whether they count toward the account's billing-period allowance is
 *   unknown);
 *   only canonical tiles are billed. A stamp resolves to the first frame at
 *   or after it, so the walk steps back 1.5 x each product's `cadenceMs`
 *   (see `listFrames`). After a cold start, a refresh walks back only to the
 *   first frame already listed: about one or two lookups.
 * - Spend: each billed tile's `x-cost-tokens` is counted against the free
 *   month in `.gev-cache/xweather/budget.json`. Past the allowance the count
 *   warns and requests continue; spend is bounded instead by 600 source
 *   tiles a minute per client and 3,000 overall.
 * - Credentials: read from the environment on every request, so Provider
 *   Settings can add or remove them live. They appear only in upstream URL
 *   paths, never in a response, and any log line passes through `redact()`.
 */

const ORIGIN = 'https://maps.api.xweather.com';
const HOUR = 3600_000;
const PRODUCTS = Object.freeze({
  'xweather-radar': Object.freeze({
    layer: 'radar-global',
    // Nominal frame spacing; the frame walk steps back 1.5 x this.
    cadenceMs: 120_000,
    maxZoom: 9,
    metadataTtlMs: 120_000,
    title: 'Global radar reflectivity',
    coverage:
      'Global to 85°N/S (the Web Mercator limit); satellite-derived where no ground radar reports.',
    description:
      'Xweather global radar mosaic (reflectivity, dBZ), filled with satellite-derived precipitation outside radar range; frames about every 2 minutes. Not a rainfall forecast.',
  }),
  'xweather-lightning': Object.freeze({
    layer: 'lightning-flash',
    cadenceMs: 300_000,
    maxZoom: 10,
    metadataTtlMs: 300_000,
    title: 'Lightning flashes',
    coverage: 'Global to 85°N/S (the Web Mercator limit).',
    description:
      'Recent lightning flashes from the Vaisala global network, drawn by Xweather as symbols; frames about every 5 minutes. Individual flashes, not a density grid.',
  }),
});
// One image never fetches more source tiles than this, so one detail window
// costs at most 192 units.
const MAX_TILES_PER_IMAGE = 192;
const MAX_TILES_PER_OUTPUT_TILE = 9;
const MAX_TILE_BYTES = 1024 * 1024;
const BOUNDS = Object.freeze({
  west: -180,
  south: -85.0511,
  east: 180,
  north: 85.0511,
});
// Whole-extent images and detail windows: 2:1 sizes up to 4096×2048.
const IMAGE = Object.freeze({ width: 4096, height: 2048 });
const IMAGE_SIZES = Object.freeze(['1024x512', '2048x1024', '4096x2048']);
// Source tiles fetched at once for one output, so a 192-tile image waits
// its turn instead of filling the upstream queue by itself.
const SOURCES_PER_OUTPUT = 8;

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/** `promise`, or the signal's reason as soon as the caller stops waiting. */
function until(promise, signal) {
  return new Promise((resolve, reject) => {
    const leave = () => reject(signal.reason);
    signal.addEventListener('abort', leave, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', leave));
  });
}

/** Run `work` over `items`, at most `limit` at a time; stop on the first failure. */
async function eachLimited(items, limit, work) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/**
 * Xweather radar and lightning under `/api/xweather`: `/status`, `/manifest`,
 * `/tile` and `/image`, with a per-client source-tile budget and
 * single-flight, concurrency-capped upstream work before any billed fetch.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {Record<string, string|undefined>} [options.env] - Read per request;
 *   `XWEATHER_MONTHLY_FREE_UNITS` overrides the free monthly allowance when it
 *   is a positive integer, read once at construction like the TomTom proxy's
 *   `TOMTOM_DAILY_TILE_BUDGET`.
 * @param {number} [options.timeoutMs] - Deadline per upstream request.
 * @param {typeof import('node:fs/promises')} [options.budgetFs] - For tests.
 * @param {string} [options.cacheDir] - Holds `budget.json`, the only file written.
 * @returns {import('vite').Plugin}
 */
export function xweatherProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  env = process.env,
  timeoutMs = 12_000,
  budgetFs,
  cacheDir = path.join(process.cwd(), '.gev-cache', 'xweather'),
} = {}) {
  const credentials = () => ({
    id: String(env.XWEATHER_CLIENT_ID || '').trim(),
    secret: String(env.XWEATHER_CLIENT_SECRET || '').trim(),
  });
  const hasKey = () => {
    const { id, secret } = credentials();
    return Boolean(id && secret);
  };
  const base = () => {
    const { id, secret } = credentials();
    return `${ORIGIN}/${encodeURIComponent(id)}_${encodeURIComponent(secret)}`;
  };
  /** Replace the credentials, raw or URL-encoded, wherever they appear. */
  const redact = (text) => {
    let out = String(text);
    for (const value of Object.values(credentials()))
      for (const form of new Set([value, encodeURIComponent(value)]))
        if (form) out = out.split(form).join('***');
    return out;
  };

  /** Positive-integer override of the free monthly allowance, or the default. */
  const monthlyAllowance = () => {
    const raw = Number.parseInt(env.XWEATHER_MONTHLY_FREE_UNITS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : XWEATHER_FREE_MONTHLY_UNITS;
  };

  const budget = createXweatherBudget({
    file: path.join(cacheDir, 'budget.json'),
    allowance: monthlyAllowance(),
    now,
    ...(budgetFs ? { fs: budgetFs } : {}),
  });
  // Frame walks are cheap (no map units), so they are admitted by request
  // count. Compositions are charged the source tiles they would fetch,
  // which bounds spend: at most 600 units a minute per client and 3,000
  // for everyone.
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 1200,
  });
  const chargeTiles = makeUnitLimiter({
    windowMs: 60_000,
    max: 600,
    globalMax: 3000,
    now,
  });
  // Frame lookups and source tiles share one gate, so at most eight upstream
  // requests run at once. Compositions have their own gate: one waits on
  // many source tiles, and in the upstream gate it would hold the slots its
  // own tiles need. Four at once bounds the decoded tiles they hold.
  const run = createUpstreamGate({ timeoutMs });
  const compose = createUpstreamGate({
    concurrency: 4,
    timeoutMs: timeoutMs * 4,
  });
  const metadata = new Map();
  const attempts = new Map();
  const refreshing = new Map();
  const refreshFailures = new Map();
  const sources = new Map();
  const outputs = new Map();
  const outputFailures = new Map();
  const clearPngs = new Map();
  let outputBytes = 0;
  let upstreamError = null;

  function refused(layer, detail) {
    if (!upstreamError)
      console.warn(redact(`[xweather] ${layer} refused: ${detail}`));
    upstreamError = 'xweather_upstream_error';
  }
  /**
   * Start the product's frame walk, or join the one in flight. Walks belong
   * to no client, so one that a caller stops waiting for still completes and
   * serves the next request. A new walk waits out 30 s after the previous
   * attempt and spends `admit()` (a request count); throws
   * `xweather_unavailable` or 429 `xweather_rate_limited` when it cannot
   * start.
   */
  function refresh(product, admit) {
    if (refreshing.has(product)) return refreshing.get(product);
    if (now() - (attempts.get(product) ?? -Infinity) < 30_000)
      throw failure('xweather_unavailable');
    if (!admit()) throw failure('xweather_rate_limited', 429);
    attempts.set(product, now());
    const spec = PRODUCTS[product];
    const old = metadata.get(product);
    const detached = new AbortController().signal;
    const walk = (async () => {
      try {
        const frames = await listFrames({
          resolve: async (at) => {
            const found = await run(
              `frame:${spec.layer}:${at}`,
              (activeSignal) =>
                resolveFrame({
                  fetchImpl,
                  base: base(),
                  layer: spec.layer,
                  at,
                  signal: activeSignal,
                }),
              detached,
            );
            upstreamError = null;
            return found;
          },
          stepMs: 1.5 * spec.cadenceMs,
          now,
          // Only frames newer than these are looked up; see listFrames.
          known: (old?.times ?? [])
            .filter((time) => old.frames.has(time))
            .map((time) => ({ time, frame: old.frames.get(time) })),
        });
        // Keep a rolling union so a frame just shown stays requestable after
        // the next walk drops it, as NOAA's 26 allowed times do.
        const known = new Map(old?.frames);
        for (const { time, frame } of frames) known.set(time, frame);
        const allowedTimes = [...known.keys()]
          .filter((time) => now() - Date.parse(time) <= 24 * HOUR)
          .sort()
          .slice(-26);
        if (!frames.length || !allowedTimes.length)
          throw failure('xweather_unavailable');
        const value = {
          times: frames.map(({ time }) => time),
          allowedTimes,
          frames: new Map(allowedTimes.map((time) => [time, known.get(time)])),
          fetchedAt: now(),
        };
        metadata.set(product, value);
        return value;
      } catch (error) {
        refreshFailures.set(product, now());
        // A lookup Xweather refused (401/403, or a JSON body); a 404, 429,
        // 5xx or an offline fetch is not a refusal.
        if (error.code === 'xweather_upstream_error')
          refused(spec.layer, 'frame lookup refused');
        throw error;
      } finally {
        refreshing.delete(product);
      }
    })();
    refreshing.set(product, walk);
    return walk;
  }
  /**
   * The product's frame list. A fresh list is returned as is. A stale one
   * that `serves(value)` accepts is returned at once while a refresh runs
   * behind it (stale-while-revalidate), so a cache hit never waits on
   * Xweather. Otherwise (a cold start, a list older than an hour, or one
   * that lacks what the caller needs) the caller waits for the walk.
   */
  async function getMetadata(product, signal, admit, serves = () => true) {
    signal.throwIfAborted();
    const spec = PRODUCTS[product];
    const view = (value) => ({
      ...value,
      stale: (refreshFailures.get(product) ?? -Infinity) >= value.fetchedAt,
    });
    const old = metadata.get(product);
    const usable = old && now() - old.fetchedAt <= HOUR ? old : null;
    if (usable && now() - usable.fetchedAt < spec.metadataTtlMs)
      return view(usable);
    if (usable && serves(usable)) {
      try {
        refresh(product, admit).catch(() => {});
      } catch {
        // Cooling down or rate limited: the current list still serves.
      }
      return view(usable);
    }
    try {
      return view(await until(refresh(product, admit), signal));
    } catch (error) {
      signal.throwIfAborted();
      if (error.status === 429 && !usable) throw error;
      if (usable) return view(usable);
      throw failure('xweather_unavailable');
    }
  }
  async function fetchTile(layer, frame, z, x, y, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(
      `${base()}/${layer}/${z}/${x}/${y}/${frame}.png`,
      { signal, redirect: 'error', headers: { Accept: 'image/png' } },
    );
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !/^image\/png(?:;|$)/i.test(type)) {
      await response.body?.cancel();
      // Only a refusal (401/403, or a JSON 200) shows on the card; a 404,
      // 429 or 5xx is Xweather being unavailable, not refusing the key.
      const code = xweatherRefused(response);
      if (code === 'xweather_upstream_error')
        refused(layer, `HTTP ${response.status} ${type.slice(0, 64)}`);
      throw failure(code);
    }
    // Recorded before the body is read: Xweather bills the response it
    // sent, including one the size cap then refuses.
    budget.record(response);
    let bytes;
    try {
      bytes = await readResponseBytesCapped(response, MAX_TILE_BYTES);
    } catch (error) {
      if (!response.body?.locked) await response.body?.cancel();
      throw error;
    }
    signal.throwIfAborted();
    let image;
    try {
      image = decodePng(bytes);
    } catch {
      image = null;
    }
    if (image?.width !== 256 || image?.height !== 256)
      throw failure('xweather_upstream_unavailable');
    upstreamError = null;
    // Transparent tiles (most lightning tiles) are remembered as null.
    for (let i = 3; i < image.data.length; i += 4)
      if (image.data[i]) return image.data;
    return null;
  }
  /** Decoded RGBA for one canonical source tile, or null when it is empty. */
  async function sourceTile(layer, frame, z, x, y, signal) {
    const key = `${layer}:${frame}:${z}/${x}/${y}`;
    if (sources.has(key)) {
      const pixels = sources.get(key);
      sources.delete(key);
      sources.set(key, pixels);
      return pixels;
    }
    return run(
      `tile:${key}`,
      async (activeSignal) => {
        const pixels = await fetchTile(layer, frame, z, x, y, activeSignal);
        // 512 decoded tiles of 256 KiB each: at most 128 MiB.
        sources.delete(key);
        while (sources.size >= 512) sources.delete(sources.keys().next().value);
        sources.set(key, pixels);
        return pixels;
      },
      signal,
    );
  }
  /** A fully transparent PNG, encoded once per size. */
  function clearPng(width, height) {
    const size = `${width}x${height}`;
    if (!clearPngs.has(size))
      clearPngs.set(
        size,
        encodePng({ width, height, data: new Uint8Array(width * height * 4) }),
      );
    return clearPngs.get(size);
  }
  /** Each `[x, y]` of a Mercator tile range, row by row. */
  function tilesOf(range) {
    const coords = [];
    for (let y = range.y0; y <= range.y1; y++)
      for (let x = range.x0; x <= range.x1; x++) coords.push([x, y]);
    return coords;
  }
  /** One equirectangular PNG of `bbox`, stitched from the tiles of `range`. */
  async function render(spec, frame, bbox, width, height, range, signal) {
    const coords = tilesOf(range);
    const pixels = new Map();
    await eachLimited(coords, SOURCES_PER_OUTPUT, async ([x, y]) => {
      pixels.set(
        `${x}/${y}`,
        await sourceTile(spec.layer, frame, range.z, x, y, signal),
      );
    });
    signal.throwIfAborted();
    if (![...pixels.values()].some(Boolean)) return clearPng(width, height);
    return encodePngAsync({
      width,
      height,
      data: reprojectToGeographic({
        bbox,
        width,
        height,
        range,
        tile: (x, y) => pixels.get(`${x}/${y}`) ?? null,
      }),
    });
  }
  function rememberOutput(key, bytes) {
    if (outputs.has(key)) outputBytes -= outputs.get(key).bytes.length;
    outputs.delete(key);
    while (
      outputs.size >= 128 ||
      outputBytes + bytes.length > 64 * 1024 * 1024
    ) {
      const oldest = outputs.keys().next().value;
      if (oldest === undefined) break;
      outputBytes -= outputs.get(oldest).bytes.length;
      outputs.delete(oldest);
    }
    outputs.set(key, { bytes, at: now() });
    outputBytes += bytes.length;
  }
  async function spend() {
    const { used, allowance, over } = await budget.snapshot();
    return { used, allowance, over };
  }
  function describe(product, value, budgetState, reason = null) {
    const spec = PRODUCTS[product];
    const time = value?.times.at(-1) ?? null;
    return {
      schemaVersion: 1,
      product,
      title: spec.title,
      coverage: spec.coverage,
      description: spec.description,
      source: 'Vaisala Xweather',
      attribution: 'Vaisala Xweather',
      bounds: value ? { ...BOUNDS } : null,
      times: value?.times ?? [],
      latest: time,
      time,
      observedAt: time,
      fetchedAt: value?.fetchedAt ?? null,
      stale: value?.stale ?? true,
      unavailable: !value,
      reason: !value
        ? (reason ?? 'Weather imagery unavailable')
        : value.stale
          ? 'Cached weather metadata; upstream unavailable'
          : null,
      tileSize: 256,
      maxLevel: 6,
      tilingScheme: 'geographic',
      tileTemplate: time
        ? `/api/xweather/tile?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}`
        : null,
      imageUrl: time
        ? `/api/xweather/image?product=${product}&time=${encodeURIComponent(time)}`
        : null,
      imageSize: { ...IMAGE },
      budget: budgetState,
    };
  }
  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 429 ? { 'Retry-After': '2' } : {}),
    });
    res.end(JSON.stringify(body));
  }
  function png(res, bytes) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
  }
  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET')
        return json(res, 405, { error: 'method_not_allowed' });
      if (!['/status', '/manifest', '/tile', '/image'].includes(url.pathname))
        return json(res, 404, { error: 'not_found' });
      const allowed =
        url.pathname === '/status'
          ? []
          : url.pathname === '/manifest'
            ? ['product']
            : url.pathname === '/image'
              ? ['product', 'time', 'size', 'bbox']
              : ['product', 'time', 'z', 'x', 'y', 'size'];
      if (
        req.url.length > 512 ||
        [...url.searchParams.keys()].some(
          (key) =>
            !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
        )
      )
        return json(res, 400, { error: 'invalid_weather_query' });
      // Never rate-limited and never upstream: the card polls it for the
      // monthly count and the last upstream refusal.
      if (url.pathname === '/status') {
        const snapshot = await budget.snapshot();
        if (controller.signal.aborted) return;
        return json(res, 200, {
          hasKey: hasKey(),
          ...snapshot,
          upstreamError,
        });
      }
      const product = url.searchParams.get('product');
      if (!Object.hasOwn(PRODUCTS, product))
        return json(res, 400, { error: 'unknown_weather_product' });
      const spec = PRODUCTS[product];
      const wholeImage = url.pathname === '/image';
      const detailBox = wholeImage
        ? weatherImageBbox(url.searchParams.get('bbox'))
        : null;
      // Xweather's bounds are fixed, so containment is checked before any
      // metadata, unlike NOAA's advertised extents.
      if (
        detailBox &&
        (detailBox[1] < BOUNDS.south || detailBox[3] > BOUNDS.north)
      )
        throw failure('invalid_weather_bbox', 400);
      const size =
        url.searchParams.get('size') ??
        (wholeImage ? `${IMAGE.width}x${IMAGE.height}` : '256');
      if (
        wholeImage
          ? !IMAGE_SIZES.includes(size)
          : !['256', '512', '1024'].includes(size)
      )
        throw failure(
          wholeImage
            ? 'invalid_weather_image_size'
            : 'invalid_weather_tile_size',
          400,
        );
      const coords =
        url.pathname === '/tile'
          ? ['z', 'x', 'y'].map((key) => url.searchParams.get(key))
          : null;
      if (coords?.some((value) => !/^(?:0|[1-9]\d{0,2})$/.test(value ?? '')))
        throw failure('invalid_weather_tile', 400);
      const tileBounds = coords
        ? weatherTileBounds(...coords.map(Number))
        : null;
      const time = url.searchParams.get('time');
      if (
        url.pathname !== '/manifest' &&
        (!time || observationTime(time) !== time)
      )
        throw failure('invalid_weather_time', 400);
      if (!hasKey()) {
        if (url.pathname !== '/manifest')
          return json(res, 503, { error: 'no_key' });
        const budgetState = await spend();
        if (controller.signal.aborted) return;
        return json(
          res,
          200,
          describe(product, null, budgetState, 'Xweather key not configured'),
        );
      }
      // Geographic tiles wholly beyond Mercator coverage have no imagery at
      // any time, so a well-formed time needs no frame list to answer them.
      if (
        tileBounds &&
        (tileBounds[1] >= MERCATOR_MAX_LAT ||
          tileBounds[3] <= -MERCATOR_MAX_LAT)
      )
        return png(res, clearPng(Number(size), Number(size)));
      // Only work that can reach Xweather spends a limit: a frame walk (one
      // request) or a composition (the source tiles it lacks), never a
      // cache hit.
      const admit = () => allow(clientKey(req));
      if (url.pathname === '/manifest') {
        let value = null;
        try {
          value = await getMetadata(product, controller.signal, admit);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error.status === 429) throw error;
        }
        const budgetState = await spend();
        if (controller.signal.aborted) return;
        return json(res, 200, describe(product, value, budgetState));
      }
      if (now() - Date.parse(time) > 24 * HOUR)
        throw failure('unknown_weather_time', 400);
      // A time the current list already names is served from it even while
      // the list is being refreshed; only an unknown time waits for the walk.
      const value = await getMetadata(
        product,
        controller.signal,
        admit,
        (known) => known.allowedTimes.includes(time),
      );
      controller.signal.throwIfAborted();
      if (!value.allowedTimes.includes(time))
        throw failure('unknown_weather_time', 400);
      // Canonical frames are exact, so stale metadata still names real
      // frames; unlike NOAA's nearestValue WMS nothing can be substituted.
      const frame = value.frames.get(time);
      const bbox =
        detailBox ??
        (wholeImage
          ? [BOUNDS.west, BOUNDS.south, BOUNDS.east, BOUNDS.north]
          : tileBounds);
      const [width, height] = wholeImage
        ? size.split('x').map(Number)
        : [Number(size), Number(size)];
      const key = `${product}:${time}:${wholeImage ? `image:${size}:${bbox.join(',')}` : `tile:${size}:${coords.join('/')}`}`;
      let cached = outputs.get(key);
      if (cached && now() - cached.at <= 24 * HOUR) {
        outputs.delete(key);
        outputs.set(key, cached);
      } else {
        if (now() - (outputFailures.get(key) ?? -Infinity) < 30_000)
          throw failure('xweather_unavailable');
        const range = chooseMercatorZoom(bbox, width, {
          maxZoom: spec.maxZoom,
          maxTiles: wholeImage
            ? MAX_TILES_PER_IMAGE
            : MAX_TILES_PER_OUTPUT_TILE,
        });
        // Charged only the source tiles not already decoded, which is what
        // this composition can bill. A request joining the same composition
        // in flight, or two racing for the same missing tiles, are each
        // charged, erring towards refusal.
        const missing = tilesOf(range).filter(
          ([x, y]) =>
            !sources.has(`${spec.layer}:${frame}:${range.z}/${x}/${y}`),
        ).length;
        if (!chargeTiles(clientKey(req), missing))
          throw failure('xweather_rate_limited', 429);
        try {
          const bytes = await compose(
            `output:${key}`,
            (signal) => render(spec, frame, bbox, width, height, range, signal),
            controller.signal,
          );
          rememberOutput(key, bytes);
          cached = { bytes };
        } catch (error) {
          // A client that left, or a lookup cancelled under it, says nothing
          // about Xweather; only real failures wait out the cooldown.
          if (
            !controller.signal.aborted &&
            error.status !== 429 &&
            error.code !== 'xweather_aborted'
          ) {
            outputFailures.delete(key);
            outputFailures.set(key, now());
            while (outputFailures.size > 128)
              outputFailures.delete(outputFailures.keys().next().value);
          }
          throw error;
        }
      }
      png(res, cached.bytes);
    } catch (error) {
      if (!controller.signal.aborted)
        json(
          res,
          error.status === 400 || error.status === 429 ? error.status : 503,
          {
            error:
              error.status === 400 || error.status === 429
                ? error.code
                : 'xweather_unavailable',
          },
        );
    } finally {
      res.removeListener?.('close', close);
    }
  }
  return {
    name: 'xweather',
    configureServer({ middlewares }) {
      middlewares.use('/api/xweather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/xweather', handler);
    },
  };
}

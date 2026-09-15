import sharp from 'sharp';
import {
  GOES_SATELLITES,
  GOES_STAR_PRODUCT,
  GOES_STAR_PRODUCTS,
  isGoESStarProduct,
} from './goes/catalog.js';
import { fetchStarFrame } from './goes/star.js';
import { createFrameCache } from './goes/cache.js';
import { satelliteNav } from './geostationary/projection.js';
import { reprojectToEquirectangular } from './geostationary/raster.js';

// STAR JPEG values are display brightness, not calibrated temperature. These
// conservative ramps/masks are deliberately only an approximate visual proxy.
export function infraredPalette(value) {
  const stops = [
    [0, [8, 8, 28]],
    [48, [20, 55, 150]],
    [96, [0, 190, 220]],
    [144, [30, 190, 80]],
    [192, [245, 220, 30]],
    [224, [240, 80, 10]],
    [255, [255, 255, 255]],
  ];
  for (let i = 1; i < stops.length; i++)
    if (value <= stops[i][0]) {
      const [a, ca] = stops[i - 1],
        [b, cb] = stops[i],
        t = (value - a) / (b - a);
      return [
        ...ca.map((v, j) => Math.round(v + (cb[j] - v) * t)),
        value < 8 ? 0 : 255,
      ];
    }
  return [255, 255, 255, 255];
}
export function applyCloudProduct(rgba, product, companionGray) {
  for (let i = 0; i < rgba.length; i += 4) {
    const v = rgba[i];
    if (product === 'ABI13') rgba.set(infraredPalette(v), i);
    if (product === 'ABI2' && companionGray) {
      /* brightness is an uncalibrated proxy: hide only very warm-looking backgrounds, conservatively. */ if (
        companionGray[i / 4] > 225
      )
        rgba[i + 3] = Math.min(rgba[i + 3], 32);
    }
  }
  return rgba;
}

/** Install the keyless GOES imagery proxy. */
export function goesProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  outputHeight = null,
  ttlMs = 5 * 60_000,
  maxOutputHeight = 4096,
} = {}) {
  const cache = createFrameCache();
  const manifests = new Map();
  let refreshing = null;
  async function refresh(product) {
    const spec = GOES_STAR_PRODUCTS[product];
    const fetchedAt = now();
    const sources = await Promise.all(
      GOES_SATELLITES.map(async (satellite) => {
        try {
          const frame = await fetchStarFrame(satellite, {
            fetchImpl,
            size: spec.endpointSize,
            product,
          });
          const frameId = `${satellite.id.toLowerCase()}-${product.toLowerCase()}-${frame.contentHash.slice(0, 12)}`;
          let sourceWidth = spec.endpointSize;
          let sourceHeight = spec.endpointSize;
          let parts = cache.get(frameId);
          if (!parts) {
            const decoded = await sharp(frame.buffer)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            sourceWidth = decoded.info.width;
            sourceHeight = decoded.info.height;
            if (product !== 'GEOCOLOR') {
              if (product === 'ABI13') applyCloudProduct(decoded.data, product);
              // ABI2 companion masking is intentionally conservative. A full
              // calibrated temperature retrieval is unavailable from STAR JPEG.
            }
            const projected = reprojectToEquirectangular({
              rgba: decoded.data,
              srcWidth: decoded.info.width,
              srcHeight: decoded.info.height,
              nav: satelliteNav(satellite.lon0),
              outputHeight:
                outputHeight ?? Math.min(spec.nativeHeight, maxOutputHeight),
              ownershipLongitudes: GOES_SATELLITES.map((entry) => entry.lon0),
              ownerLon0: satellite.lon0,
            });
            parts = await Promise.all(
              projected.parts.map(async (part) => ({
                png: await sharp(part.rgba, {
                  raw: { width: part.width, height: part.height, channels: 4 },
                })
                  .png()
                  .toBuffer(),
                width: part.width,
                height: part.height,
                rectangle: part.rectangle,
              })),
            );
            cache.put(frameId, parts);
          }
          return {
            satelliteId: satellite.id,
            subSatelliteLongitude: satellite.lon0,
            product,
            upstreamProduct: product,
            frameId,
            observationTime: frame.lastModifiedMs,
            observationTimeSource:
              frame.lastModifiedMs == null ? 'unknown' : 'last-modified',
            stale: false,
            unavailable: false,
            reason: null,
            sourceWidth,
            sourceHeight,
            requestedWidth: spec.endpointSize,
            requestedHeight: spec.endpointSize,
            sourceResolutionKm:
              spec.fallbackResolutionKm ?? spec.nominalResolutionKm,
            nominalResolutionKm: spec.nominalResolutionKm,
            resolutionState: spec.resolutionState,
            nativeWidth: spec.nativeWidth,
            nativeHeight: spec.nativeHeight,
            nativeResolutionKm: spec.nominalResolutionKm,
            fallbackResolutionKm: spec.fallbackResolutionKm ?? null,
            nativeZipNote: spec.nativeZipNote ?? null,
            parts: parts.map((part, i) => ({
              url: `/api/goes/frames/${frameId}/${i}.png`,
              rectangle: part.rectangle,
              width: part.width,
              height: part.height,
            })),
          };
        } catch (error) {
          const previous = manifests
            .get(product)
            ?.sources.find((source) => source.satelliteId === satellite.id);
          return previous
            ? { ...previous, unavailable: true, reason: error.message }
            : {
                satelliteId: satellite.id,
                subSatelliteLongitude: satellite.lon0,
                product: 'imagery',
                upstreamProduct: GOES_STAR_PRODUCT,
                frameId: null,
                observationTime: null,
                observationTimeSource: 'unknown',
                stale: false,
                unavailable: true,
                reason: error.message,
                parts: [],
              };
        }
      }),
    );
    const result = {
      schemaVersion: 1,
      family: 'goes',
      product,
      fetchedAt,
      sources,
    };
    manifests.set(product, result);
    return result;
  }
  function json(res, value, status = 200) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
  }
  async function middleware(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/goes/manifest') {
      const product = url.searchParams.get('product') || GOES_STAR_PRODUCT;
      if (!isGoESStarProduct(product))
        return json(res, { error: 'unsupported_product' }, 400);
      let manifest = manifests.get(product);
      if (!manifest || now() - manifest.fetchedAt >= ttlMs) {
        refreshing ||= refresh(product).finally(() => {
          refreshing = null;
        });
        try {
          manifest = await refreshing;
        } catch {
          if (!manifest)
            return json(res, {
              schemaVersion: 1,
              family: 'goes',
              product,
              fetchedAt: now(),
              sources: [],
            });
        }
      }
      return json(res, manifest);
    }
    const match = url.pathname.match(
      /^\/api\/goes\/frames\/([^/]+)\/(\d+)\.png$/,
    );
    if (match) {
      const parts = cache.get(match[1]);
      const part = parts?.[Number(match[2])];
      if (!part) return json(res, { error: 'unknown_frame' }, 404);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=300, immutable');
      res.end(part.png);
      return;
    }
    if (url.pathname === '/api/goes/status')
      return json(res, {
        fetchedAt: Math.max(
          ...[...manifests.values()].map((m) => m.fetchedAt),
          0,
        ),
        ttlMs,
        sources: [...manifests.values()]
          .flatMap((m) => m.sources)
          .map(
            ({
              satelliteId,
              frameId,
              observationTime,
              unavailable,
              reason,
            }) => ({
              satelliteId,
              frameId,
              observationTime,
              unavailable,
              reason,
            }),
          ),
      });
    return next();
  }
  return {
    name: 'goes',
    // Do NOT return the middleware: Vite treats a truthy return from
    // configureServer as a post-hook and would invoke the Connect app itself.
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

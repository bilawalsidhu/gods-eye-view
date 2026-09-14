/**
 * CCTV camera proxy (`/api/cctv/*`).
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CCTV_SOURCE_FILE, buildMediaPassthrough, buildStreamPayload, buildSyntheticCctvSvg, createCctvHealthTracker, fetchCctvImageFromUpstream, fetchMediaHeadersBounded, getCctvSources, isVideoFeedType, normalizeFeedType, parseConfiguredSourcesFromEnv, streetViewFallback } from '../../src/data/cctvSources.js';
import { safeRangeHeader } from '../../src/data/externalUrlPolicy.js';
import { resolveServerGoogleApiKey } from '../../src/data/googlePlacesPolicy.js';
import { Readable } from 'node:stream';

import { fileURLToPath } from 'node:url';

/** Repo-root resolution: vite.config.js sat at the checkout root, so its
 *  `__dirname` pointed there; these modules live one level deeper. */
const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Coerce a fetch() response body to a Node.js Readable stream.
 *
 * Handles both Node-native streams (.pipe) and web ReadableStreams (.getReader).
 *
 * @param {ReadableStream|NodeJS.ReadableStream|null} body
 * @returns {import('stream').Readable|null}
 */
export function toReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') {
    return Readable.fromWeb(body);
  }
  return null;
}

/**
 * Load CCTV sources from a local JSON file (CCTV_SOURCES_FILE env or default).
 * Node-only (needs `fs`), so it never moved to `src/data/cctvSources.js` — the
 * result is injected into `getCctvSources({ configuredSources })` instead.
 *
 * @returns {Array<object>} Array of raw source objects, or [] on error.
 */
export function loadSourcesFromFile() {
  const sourceFile = process.env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(__dirname, sourceFile);
  try {
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[CCTV] failed to read source file:', resolved, error?.message || error);
    return [];
  }
}

/**
 * Vite plugin: CCTV camera proxy with source registry, frame/media serving,
 * fallback chain (upstream -> Street View -> synthetic SVG), and health tracking.
 *
 * The subsystem itself (catalog loading, feed-type normalization, frame
 * fallback chain, health tracker) lives in `src/data/cctvSources.js`, shared
 * with the production Pages Function `functions/api/cctv/[[path]].js`. What
 * stays here is only what needs Node: reading the config-file catalog from
 * disk and piping upstream media into the Node response.
 *
 * Endpoints:
 *   GET /api/cctv/sources        — list all registered camera sources
 *   GET /api/cctv/health         — per-camera health/status report
 *   GET /api/cctv/stream/:id     — stream info (feedType, URLs) for a camera
 *   GET /api/cctv/media/:id      — proxy live video/image media from upstream
 *   GET /api/cctv/frame/:id      — single frame with fallback chain
 *
 * @returns {import('vite').Plugin}
 */
export function cctvProxy() {
  const { setHealth, listHealth } = createCctvHealthTracker();

  /** Pipe an upstream media Response into the Node client response. */
  const proxyMediaResponse = async (res, upstream, { sourceHeader = 'upstream' } = {}) => {
    const passthrough = buildMediaPassthrough(upstream, { sourceHeader });
    if (!passthrough.ok) {
      res.writeHead(passthrough.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: passthrough.error }));
      try { await upstream.body?.cancel(); } catch { /* no-op */ }
      return;
    }

    res.writeHead(passthrough.status, passthrough.headers);

    const stream = toReadable(upstream.body);
    if (!stream) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
      return;
    }

    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  };

  return {
    name: 'cctv-proxy',
    configureServer(server) {
      server.middlewares.use('/api/cctv', async (req, res) => {
        try {
          // Sources come from the config file + CCTV_SOURCES_JSON (both need
          // Node here), while the catalog assembly, live packs, and caps run in
          // the shared module.
          const sources = await getCctvSources({
            configuredSources: [
              ...loadSourcesFromFile(),
              ...parseConfiguredSourcesFromEnv(process.env.CCTV_SOURCES_JSON),
            ],
            env: process.env,
          });
          const sourceById = new Map(sources.map((source) => [source.id, source]));
          const url = new URL(req.url || '/', 'http://localhost');

          if (url.pathname === '/sources') {
            const body = {
              sources: sources.map((source) => ({
                id: source.id,
                name: source.name,
                city: source.city,
                cityId: source.cityId,
                provider: source.provider,
                lat: source.lat,
                lon: source.lon,
                headingDeg: source.headingDeg,
                headingConfidence: source.headingConfidence || '',
                pitchDeg: source.pitchDeg,
                fovDeg: source.fovDeg,
                rangeM: source.rangeM,
                mountHeightM: source.mountHeightM,
                groundElevationM: source.groundElevationM,
                feedType: normalizeFeedType(source.feedType),
                sourceKind: source.sourceKind || (source.url ? 'configured' : 'fallback'),
                poseSource: source.poseSource,
                license: source.license,
              })),
            };
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
            return;
          }

          if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ cameras: listHealth() }));
            return;
          }

          if (url.pathname.startsWith('/stream/')) {
            const cameraId = decodeURIComponent(url.pathname.replace('/stream/', '').trim()) || 'camera';
            const source = sourceById.get(cameraId);
            const payload = buildStreamPayload(source, cameraId);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(payload));
            return;
          }

          if (url.pathname.startsWith('/media/')) {
            const cameraId = decodeURIComponent(url.pathname.replace('/media/', '').trim()) || 'camera';
            const source = sourceById.get(cameraId);
            const mediaUrl = source?.url || '';
            const feedType = normalizeFeedType(source?.feedType || 'image');

            if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'fallback',
                label: source?.provider || 'No upstream URL',
                message: 'No stream URL configured',
              });
              res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: 'No media URL configured for this camera' }));
              return;
            }

            try {
              const upstreamHeaders = { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' };
              // Forward only a well-formed byte range; anything else is dropped
              // and the upstream serves the full body (issue #27).
              const requestRange = safeRangeHeader(req.headers?.range);
              if (requestRange) upstreamHeaders.Range = requestRange;
              // Bounded wait for response headers (issue #25): a dark upstream
              // cannot hold this request forever; disarmed below once we take
              // the body so a healthy unbounded stream is never killed.
              const media = await fetchMediaHeadersBounded(mediaUrl, { headers: upstreamHeaders });
              if (!media.ok) throw new Error('Media upstream timed out');
              const upstream = media.upstream;
              media.disarm();
              const contentType = upstream.headers.get('content-type') || '';
              if (!upstream.ok) {
                setHealth(cameraId, {
                  status: 'degraded',
                  sourceKind: 'upstream',
                  label: source?.provider || 'Configured source',
                  message: `Upstream HTTP ${upstream.status}`,
                });
                res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ error: `Upstream returned ${upstream.status}` }));
                return;
              }

              if (isVideoFeedType(feedType) && !(contentType.startsWith('video/') || contentType.includes('mpegurl'))) {
                setHealth(cameraId, {
                  status: 'degraded',
                  sourceKind: 'upstream',
                  label: source?.provider || 'Configured source',
                  message: `Unexpected media type ${contentType || 'unknown'}`,
                });
              } else {
                setHealth(cameraId, {
                  status: 'ok',
                  sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
                  label: source?.provider || 'Configured source',
                  message: isVideoFeedType(feedType) ? 'Live stream connected' : 'Snapshot feed connected',
                });
              }

              await proxyMediaResponse(res, upstream, {
                sourceHeader: isVideoFeedType(feedType) ? 'live-media' : 'upstream-image',
              });
              return;
            } catch (error) {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: error?.message || 'Media fetch failed',
              });
              res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: 'Media proxy failed' }));
              return;
            }
          }

          if (!url.pathname.startsWith('/frame/')) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }

          const cameraId = decodeURIComponent(url.pathname.replace('/frame/', '').trim()) || 'camera';
          const source = sourceById.get(cameraId);
          const label = url.searchParams.get('label') || source?.name || cameraId;
          const city = url.searchParams.get('city') || source?.city || '';
          const lat = Number(url.searchParams.get('lat') || source?.lat);
          const lon = Number(url.searchParams.get('lon') || source?.lon);
          const heading = Number(url.searchParams.get('heading') || source?.headingDeg);
          const fov = Number(url.searchParams.get('fov') || source?.fovDeg);
          const pitch = Number(url.searchParams.get('pitch') || source?.pitchDeg);

          // Only use server-registered upstream URLs — never accept client-supplied URLs
          // (prevents SSRF via ?upstream= query parameter)
          const upstreamCandidate =
            source?.snapshotUrl
            || (!isVideoFeedType(normalizeFeedType(source?.feedType)) ? source?.url : '');

          const upstreamImage = await fetchCctvImageFromUpstream(upstreamCandidate);
          if (upstreamImage?.ok) {
            setHealth(cameraId, {
              status: 'ok',
              sourceKind: 'snapshot',
              label: source?.provider || 'Configured source',
              message: 'Upstream snapshot active',
            });
            res.writeHead(200, {
              'Content-Type': upstreamImage.contentType,
              'Cache-Control': 'no-store',
              'X-CCTV-Source': 'upstream-image',
            });
            res.end(upstreamImage.body);
            return;
          }

          const sv = await streetViewFallback({
            lat,
            lon,
            heading,
            fov,
            pitch,
            apiKey: resolveServerGoogleApiKey(process.env),
          });
          if (sv?.ok) {
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'streetview',
              label: 'Google Street View',
              message: 'Fallback Street View frame',
            });
            res.writeHead(200, {
              'Content-Type': sv.contentType,
              'Cache-Control': 'no-store',
              'X-CCTV-Source': 'streetview',
            });
            res.end(sv.body);
            return;
          }

          const svg = buildSyntheticCctvSvg({
            cameraId,
            label,
            city,
            status: source?.url ? 'UPSTREAM UNAVAILABLE' : 'NO UPSTREAM CONFIGURED',
          });

          setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'synthetic',
            label: source?.provider || 'Synthetic fallback',
            message: source?.url ? 'Upstream unavailable' : 'No source configured',
          });

          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'synthetic',
          });
          res.end(svg);
        } catch (error) {
          console.error('[CCTV Proxy]', error?.message || String(error));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CCTV proxy error' }));
        }
      });
    },
  };
}

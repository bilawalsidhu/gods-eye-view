import { createCctvCatalog } from './cctv/catalog.js';
import { quebec511VideoUrl, quebecBrowserVideoEnabled } from './cctv/quebec.js';
import { normalizeFeedType, isVideoFeedType } from './cctv/normalize.js';
import {
  buildSyntheticCctvSvg,
  cctvLiveMediaType,
  cctvRasterImageType,
  proxyMediaResponse,
  fetchCctvImageFromUpstream,
  fetchTxdotSnapshot,
  fetchCctvMediaUpstream,
  watchDownstreamClose,
} from './cctv/media.js';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_MAX_SOURCES_CEILING,
} from './cctv/constants.js';
import { sanitizeCctvRangeHeader } from './cctv/range.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { PROXY_SIGNALS } from '../../src/localRequestGate.mjs';
import { createHlsPuller } from './cctv/stream.js';
import { isMlitRiverAdjustmentImage } from './cctv/worldCameras.js';
import { ottawaAuthorizedFrameUrl } from './cctv/ottawa.js';
import { googleServerApiKey } from './places/google-key.js';
export { CCTV_FRAME_FETCH_TIMEOUT_MS, fetchCctvImageFromUpstream };
/**
 * Vite plugin: CCTV camera proxy with source registry, frame/media serving,
 * fallback chain (upstream -> Street View -> synthetic SVG), and health tracking.
 *
 * Endpoints:
 *   GET /api/cctv/sources        — list all registered camera sources
 *   GET /api/cctv/health         — per-camera health/status report
 *   GET /api/cctv/stream/:id     — stream info (feedType, URLs) for a camera
 *   GET /api/cctv/media/:id      — proxy live video media from upstream
 *   GET /api/cctv/frame/:id      — single frame with fallback chain
 *
 * @returns {import('vite').Plugin}
 */
export function cctvProxy({ sourceRoot = process.cwd() } = {}) {
  const getCctvSources = createCctvCatalog({ sourceRoot });
  /** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
  const health = new Map();
  /** Cap on health map entries to prevent unbounded growth. Sized to the
   * CCTV_MAX_SOURCES ceiling so health/status observability is never evicted
   * for any catalog the proxy can actually serve. */
  const HEALTH_MAX_ENTRIES = CCTV_MAX_SOURCES_CEILING;
  /** Live HLS strategies (see ./cctv/stream.js). Shared across dev and preview. */
  const puller = createHlsPuller();
  /**
   * Bounded transient image reuse keeps cadence-limited providers (World
   * stills, Ottawa's once-a-minute API) inside their refresh floor. The byte
   * cap is the real bound; the entry cap only limits map overhead.
   */
  const WORLD_FRAME_CACHE_MAX_ENTRIES = 1024;
  /** Retry a failed fetch sooner than a full refresh window, never under a minute. */
  const THROTTLED_FRAME_FAILURE_BACKOFF_MS = 60 * 1000;
  const WORLD_FRAME_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
  const WORLD_FRAME_CACHE_MAX_BYTES = 32 * 1024 * 1024;
  const worldFrameCache = new Map();
  const worldFrameInflight = new Map();
  const worldFrameNextAllowedAt = new Map();
  let worldFrameCacheBytes = 0;

  function getWorldFrameCache(cameraId) {
    const entry = worldFrameCache.get(cameraId);
    if (!entry) return null;
    worldFrameCache.delete(cameraId);
    worldFrameCache.set(cameraId, entry);
    return entry;
  }

  function storeWorldFrame(cameraId, image) {
    if (
      !Buffer.isBuffer(image?.body) ||
      image.body.length > WORLD_FRAME_CACHE_MAX_ENTRY_BYTES
    )
      return;
    const previous = worldFrameCache.get(cameraId);
    if (previous) worldFrameCacheBytes -= previous.body.length;
    const entry = {
      body: image.body,
      contentType: image.contentType,
      fetchedAt: Date.now(),
    };
    worldFrameCache.delete(cameraId);
    worldFrameCache.set(cameraId, entry);
    worldFrameCacheBytes += entry.body.length;
    while (
      worldFrameCache.size > WORLD_FRAME_CACHE_MAX_ENTRIES ||
      worldFrameCacheBytes > WORLD_FRAME_CACHE_MAX_BYTES
    ) {
      const oldestId = worldFrameCache.keys().next().value;
      const oldest = worldFrameCache.get(oldestId);
      worldFrameCache.delete(oldestId);
      worldFrameCacheBytes -= oldest.body.length;
    }
  }

  function setNextAllowedAt(cameraId, at) {
    worldFrameNextAllowedAt.delete(cameraId);
    worldFrameNextAllowedAt.set(cameraId, at);
    while (worldFrameNextAllowedAt.size > 4096) {
      worldFrameNextAllowedAt.delete(
        worldFrameNextAllowedAt.keys().next().value,
      );
    }
  }

  /**
   * Fetch a frame from a provider with a per-camera refresh floor. Inside the
   * floor the last frame is reused; with no frame to reuse the caller gets
   * `{ throttled: true }` and serves a placeholder, so a cadence-limited camera
   * never falls through to the key-bearing Street View fallback. A failed
   * fetch backs off for a minute (capped at the floor) instead of a full
   * window.
   */
  async function fetchThrottledFrame(source, cameraId, frameUrl) {
    const cached = getWorldFrameCache(cameraId);
    const rawRefreshMs = Number(source?.frameRefreshMs);
    const refreshMs =
      Number.isFinite(rawRefreshMs) && rawRefreshMs > 0
        ? rawRefreshMs
        : 5 * 60 * 1000;
    const now = Date.now();
    if (cached && now - cached.fetchedAt < refreshMs) {
      return { ok: true, ...cached, cached: true };
    }

    const inflight = worldFrameInflight.get(cameraId);
    if (inflight) return inflight;
    const stale = cached
      ? {
          ok: true,
          body: cached.body,
          contentType: cached.contentType,
          stale: true,
        }
      : null;
    const nextAllowedAt = worldFrameNextAllowedAt.get(cameraId) || 0;
    if (now < nextAllowedAt) return stale || { ok: false, throttled: true };
    if (!frameUrl) return stale;
    setNextAllowedAt(cameraId, now + refreshMs);
    let request;
    request = fetchCctvImageFromUpstream(frameUrl)
      .then((image) => {
        if (image?.ok) {
          storeWorldFrame(cameraId, image);
          return image;
        }
        setNextAllowedAt(
          cameraId,
          Date.now() + Math.min(refreshMs, THROTTLED_FRAME_FAILURE_BACKOFF_MS),
        );
        return stale || image;
      })
      .finally(() => {
        if (worldFrameInflight.get(cameraId) === request)
          worldFrameInflight.delete(cameraId);
      });
    worldFrameInflight.set(cameraId, request);
    return request;
  }

  /** Update the health entry for a camera, evicting the oldest entry if at capacity. */
  const setHealth = (cameraId, patch) => {
    // Evict oldest entries if the health map grows beyond the cap
    if (!health.has(cameraId) && health.size >= HEALTH_MAX_ENTRIES) {
      const oldest = health.keys().next().value;
      health.delete(oldest);
    }
    const prev = health.get(cameraId) || {};
    health.set(cameraId, {
      id: cameraId,
      status: patch.status || prev.status || 'unknown',
      sourceKind: patch.sourceKind || prev.sourceKind || 'unknown',
      label: patch.label || prev.label || '',
      message: patch.message || prev.message || '',
      updatedAt: Date.now(),
    });
  };

  /** Snapshot all camera health entries as an array. */
  const listHealth = () => Array.from(health.values());

  /** Build a JSON payload describing stream info (feedType, URLs) for a camera. */
  const buildStreamPayload = (source, cameraId) => {
    const feedType = normalizeFeedType(source?.feedType || 'image');
    return {
      id: cameraId,
      feedType,
      mediaUrl: isVideoFeedType(feedType)
        ? `/api/cctv/media/${encodeURIComponent(cameraId)}`
        : null,
      frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
      provider: source?.provider || '',
      sourceKind:
        source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
    };
  };

  /**
   * Fetch a Google Street View static image as a fallback frame. Server-side
   * call, never reaches the browser — prefers GOOGLE_MAPS_SERVER_API_KEY
   * (#33: a key scoped to Street View Static/Places, restricted by server IP
   * rather than HTTP referrer) and falls back to the browser-exposed
   * GOOGLE_MAPS_API_KEY for setups that haven't split the two yet.
   */
  const streetViewFallback = async ({ lat, lon, heading, fov, pitch }) => {
    const streetViewKey = googleServerApiKey();
    if (!streetViewKey || !Number.isFinite(lat) || !Number.isFinite(lon))
      return null;
    try {
      const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
      sv.searchParams.set('size', '960x540');
      sv.searchParams.set('location', `${lat},${lon}`);
      sv.searchParams.set(
        'heading',
        String(Number.isFinite(heading) ? heading : 0),
      );
      sv.searchParams.set(
        'fov',
        String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80),
      );
      sv.searchParams.set(
        'pitch',
        String(Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0),
      );
      sv.searchParams.set('source', 'outdoor');
      sv.searchParams.set('return_error_code', 'true');
      sv.searchParams.set('key', streetViewKey);

      const svResp = await fetch(sv.toString(), {
        headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
        signal: AbortSignal.timeout(CCTV_FRAME_FETCH_TIMEOUT_MS),
      });
      const svType = cctvRasterImageType(svResp.headers.get('content-type'));
      if (!svResp.ok || !svType) {
        try {
          await svResp.body?.cancel();
        } catch {
          /* no-op */
        }
        return null;
      }

      return {
        ok: true,
        body: Buffer.from(await svResp.arrayBuffer()),
        contentType: svType,
      };
    } catch {
      return null;
    }
  };

  const installMiddleware = (server) => {
    server.httpServer?.on('close', () => {
      puller.shutdown();
    });
    server.middlewares.use('/api/cctv', async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        // Refuse cross-site requests before any catalog or upstream work. The
        // keyless gate keeps the routes reachable behind a reverse proxy; the
        // key-bearing Street View fallback below has its own check.
        if (admitSameSiteKeyless(req, res)) return;
        const sources = await getCctvSources();
        const sourceById = new Map(
          sources.map((source) => [source.id, source]),
        );

        if (url.pathname === '/sources') {
          const quebecVideo = quebecBrowserVideoEnabled();
          const body = {
            trimmedPacks: getCctvSources.trimmedPacks?.(sources) ?? [],
            sources: sources.map((source) => ({
              id: source.id,
              pack: source.pack,
              name: source.name,
              city: source.city,
              cityId: source.cityId,
              provider: source.provider,
              lat: source.lat,
              lon: source.lon,
              frameRefreshMs: source.frameRefreshMs,
              headingDeg: source.headingDeg,
              headingConfidence: source.headingConfidence || '',
              pitchDeg: source.pitchDeg,
              fovDeg: source.fovDeg,
              rangeM: source.rangeM,
              mountHeightM: source.mountHeightM,
              groundElevationM: source.groundElevationM,
              feedType: normalizeFeedType(source.feedType),
              sourceKind:
                source.sourceKind || (source.url ? 'configured' : 'fallback'),
              sourceUrl: source.sourceUrl || '',
              browserMediaUrl:
                quebecVideo && source.sourceKind === 'quebec-511-browser'
                  ? quebec511VideoUrl(source.id)
                  : '',
              accuracyM: source.accuracyM,
              positionSource: source.positionSource || '',
              poseSource: source.poseSource,
              model: source.model || '',
              manufacturer: source.manufacturer || '',
              license: source.license,
              credit: source.credit || '',
              code: source.code || '',
              groundHeights: source.groundHeights || null,
            })),
          };
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(body));
          return;
        }

        if (url.pathname === '/health') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ cameras: listHealth() }));
          return;
        }

        if (url.pathname.startsWith('/stream/')) {
          const cameraId =
            decodeURIComponent(url.pathname.replace('/stream/', '').trim()) ||
            'camera';
          const source = sourceById.get(cameraId);
          const payload = buildStreamPayload(source, cameraId);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload));
          return;
        }

        if (url.pathname.startsWith('/media/')) {
          const match = /^\/media\/([^/]+)(?:\/(seg_(\d+)\.ts))?$/.exec(
            url.pathname,
          );
          if (!match) {
            res.writeHead(404);
            res.end();
            return;
          }
          const cameraId = decodeURIComponent(match[1]);
          const source = sourceById.get(cameraId);
          const mediaUrl = source?.url || '';
          const feedType = normalizeFeedType(source?.feedType || 'image');
          // Live feeds only. A still camera is served by /frame, whose fetch
          // keeps redirects on the registered origin, accepts only raster
          // images and caps the body; relaying it here would bypass all three.
          if (!isVideoFeedType(feedType) && feedType !== 'mjpeg') {
            res.writeHead(404, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: 'No live media for this camera; use the frame endpoint',
              }),
            );
            return;
          }
          const leaseId = url.searchParams.get('lease');
          if (feedType === 'hls' && !/^[a-f0-9-]{36}$/i.test(leaseId || '')) {
            res.writeHead(400);
            res.end();
            return;
          }
          if (req.method === 'DELETE') {
            if (leaseId) puller.release(cameraId, leaseId);
            res.writeHead(204);
            res.end();
            return;
          }
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
          }
          if (feedType === 'hls') {
            if (
              !/^https?:\/\//i.test(mediaUrl) ||
              !/\.m3u8(?:\?|$)/i.test(mediaUrl)
            ) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error:
                    'This stream requires an unsupported transport; use the frame fallback',
                }),
              );
              return;
            }
            if (match[2]) {
              const body = puller.getSegment(
                cameraId,
                url.searchParams.get('session'),
                Number(match[3]),
                leaseId,
              );
              res.writeHead(body ? 200 : 404, {
                'Content-Type': 'video/mp2t',
                'Cache-Control': 'no-store',
              });
              res.end(body || undefined);
              return;
            }
            const downstream = watchDownstreamClose(res);
            let entry;
            const cancelPending = () => {
              if (entry) puller.release(cameraId, leaseId);
            };
            try {
              entry = await puller.ensure(cameraId, mediaUrl, leaseId);
              if (downstream.closed) {
                cancelPending();
                return;
              }
              downstream.signal.addEventListener('abort', cancelPending, {
                once: true,
              });
              if (!(await puller.waitReady(entry, downstream.signal)))
                throw new Error('Stream unavailable');
              const playlist = await puller.buildPlaylist(
                entry,
                cameraId,
                leaseId,
              );
              if (downstream.closed) return;
              if (!playlist) throw new Error('Stream unavailable');
              setHealth(cameraId, {
                status: 'ok',
                sourceKind: 'live',
                label: source?.provider || 'Configured source',
                message: 'Live HLS connected',
              });
              res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store',
                'X-CCTV-Source': 'hls-pull',
                'X-CCTV-Session': entry.token,
              });
              res.end(playlist);
            } catch {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'fallback',
                label: source?.provider || 'Configured source',
                message: 'Live HLS unavailable',
              });
              if (!downstream.closed) {
                res.writeHead(503, {
                  'Content-Type': 'application/json',
                  'Cache-Control': 'no-store',
                  'Retry-After': '2',
                });
                res.end(JSON.stringify({ error: 'Live stream unavailable' }));
              }
            } finally {
              downstream.signal.removeEventListener('abort', cancelPending);
            }
            return;
          }
          if (match[2] || req.method !== 'GET') {
            res.writeHead(404);
            res.end();
            return;
          }

          if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'fallback',
              label: source?.provider || 'No upstream URL',
              message: 'No stream URL configured',
            });
            res.writeHead(404, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: 'No media URL configured for this camera',
              }),
            );
            return;
          }

          // Bound before the request goes out: most of the wait is before any
          // header arrives, and a viewer who leaves during it must take the
          // upstream request with them.
          const downstream = watchDownstreamClose(res);
          try {
            const upstreamHeaders = {
              'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
            };
            // Never forward the client's own string: a Range this proxy does
            // not accept is dropped and the request proceeds without one.
            const requestRange = sanitizeCctvRangeHeader(req.headers?.range);
            if (requestRange) upstreamHeaders.Range = requestRange;
            const upstream = await fetchCctvMediaUpstream(mediaUrl, {
              headers: upstreamHeaders,
              signal: downstream.signal,
            });
            if (downstream.closed) {
              // The headers arrived for a viewer who is no longer there.
              try {
                await upstream.body?.cancel();
              } catch {
                /* already closed */
              }
              return;
            }
            if (!upstream.ok) {
              try {
                await upstream.body?.cancel();
              } catch {
                /* already closed */
              }
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: `Upstream HTTP ${upstream.status}`,
              });
              res.writeHead(upstream.status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              });
              res.end(
                JSON.stringify({
                  error: `Upstream returned ${upstream.status}`,
                }),
              );
              return;
            }

            // The relayed type is the feed kind's own, checked before the
            // camera counts as healthy and before any byte is relayed.
            const contentType = cctvLiveMediaType(
              feedType,
              upstream.headers.get('content-type'),
            );
            if (!contentType) {
              try {
                await upstream.body?.cancel();
              } catch {
                /* already closed */
              }
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: 'Unexpected media type',
              });
              res.writeHead(502, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              });
              res.end(JSON.stringify({ error: 'Media proxy failed' }));
              return;
            }
            setHealth(cameraId, {
              status: 'ok',
              sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
              label: source?.provider || 'Configured source',
              message: isVideoFeedType(feedType)
                ? 'Live stream connected'
                : 'Snapshot feed connected',
            });

            await proxyMediaResponse(res, upstream, {
              contentType,
              sourceHeader: isVideoFeedType(feedType)
                ? 'live-media'
                : 'upstream-image',
            });
            return;
          } catch (error) {
            if (downstream.closed) {
              // The viewer left mid-request. That is not a camera fault and
              // there is nobody to answer.
              return;
            }
            const timedOut =
              error?.name === 'AbortError' || error?.name === 'TimeoutError';
            // GET /api/cctv/health serializes `message`, and the CCTV panel
            // renders it as a status label, so the raw error would leave the
            // server by a different door than the sanitized body below and
            // land on screen.
            //
            // The log line drops the text too, unlike the catch at the bottom
            // of this file: a media-fetch failure names the camera's upstream
            // host, and these lines get pasted into issues. The status codes
            // below carry the diagnosis — 504 for a timeout, 502 otherwise.
            console.warn('[CCTV Proxy] media fetch failed');
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'upstream',
              label: source?.provider || 'Configured source',
              message: 'Media fetch failed',
            });
            res.writeHead(timedOut ? 504 : 502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: timedOut
                  ? 'Upstream media timeout'
                  : 'Media proxy failed',
              }),
            );
            return;
          }
        }

        if (!url.pathname.startsWith('/frame/')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        const cameraId =
          decodeURIComponent(url.pathname.replace('/frame/', '').trim()) ||
          'camera';
        const source = sourceById.get(cameraId);
        const label = url.searchParams.get('label') || source?.name || cameraId;
        const city = url.searchParams.get('city') || source?.city || '';
        const lat = Number(url.searchParams.get('lat') || source?.lat);
        const lon = Number(url.searchParams.get('lon') || source?.lon);
        const heading = Number(
          url.searchParams.get('heading') || source?.headingDeg,
        );
        const fov = Number(url.searchParams.get('fov') || source?.fovDeg);
        const pitch = Number(url.searchParams.get('pitch') || source?.pitchDeg);

        // Only use server-registered upstream URLs — never accept client-supplied URLs
        // (prevents SSRF via ?upstream= query parameter)
        const upstreamCandidate =
          source?.snapshotUrl ||
          (!isVideoFeedType(normalizeFeedType(source?.feedType))
            ? source?.url
            : '');

        const upstreamImage =
          source?.pack === 'world-cameras'
            ? await fetchThrottledFrame(source, cameraId, upstreamCandidate)
            : source?.sourceKind === 'ottawa-traffic'
              ? await fetchThrottledFrame(
                  source,
                  cameraId,
                  ottawaAuthorizedFrameUrl(upstreamCandidate),
                )
              : source?.sourceKind === 'txdot-its'
                ? await fetchTxdotSnapshot(upstreamCandidate)
                : await fetchCctvImageFromUpstream(upstreamCandidate, {
                    allowMjpeg: source?.sourceKind === 'taiwan-highway-motc',
                  });
        if (
          source?.sourceKind === 'mlit-river' &&
          isMlitRiverAdjustmentImage(upstreamImage)
        ) {
          const svg = buildSyntheticCctvSvg({
            cameraId,
            label,
            city,
            status: 'CAMERA UNDER ADJUSTMENT',
          });
          setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'snapshot',
            label: source.provider || 'MLIT river cameras',
            message: 'Provider camera under adjustment',
          });
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'provider-maintenance',
          });
          res.end(svg);
          return;
        }
        if (upstreamImage?.throttled) {
          // Inside the provider's refresh floor with no frame to reuse: a
          // placeholder, not Street View, and no health change.
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'synthetic',
          });
          res.end(
            buildSyntheticCctvSvg({
              cameraId,
              label,
              city,
              status: 'WAITING FOR NEXT FRAME',
            }),
          );
          return;
        }
        if (upstreamImage?.ok) {
          setHealth(cameraId, {
            status: upstreamImage.stale ? 'degraded' : 'ok',
            sourceKind: 'snapshot',
            label: source?.provider || 'Configured source',
            message: upstreamImage.stale
              ? 'Serving last snapshot; refresh failed'
              : upstreamImage.cached
                ? 'Cached snapshot active'
                : 'Upstream snapshot active',
          });
          res.writeHead(200, {
            'Content-Type': upstreamImage.contentType,
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'upstream-image',
          });
          res.end(upstreamImage.body);
          return;
        }

        // The Street View fallback spends the Google key, so a forwarded
        // request (whose client this server cannot see) gets the placeholder,
        // as if no key were configured. Any forwarding header counts, even an
        // empty one.
        const forwarded = PROXY_SIGNALS.some(
          (name) => req.headers?.[name] !== undefined,
        );
        const sv = forwarded
          ? null
          : await streetViewFallback({
              lat,
              lon,
              heading,
              fov,
              pitch,
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
          status: source?.url
            ? 'UPSTREAM UNAVAILABLE'
            : 'NO UPSTREAM CONFIGURED',
        });

        setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'synthetic',
          label: source?.provider || 'Synthetic fallback',
          message: source?.url
            ? 'Upstream unavailable'
            : 'No source configured',
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
  };
  return {
    name: 'cctv-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

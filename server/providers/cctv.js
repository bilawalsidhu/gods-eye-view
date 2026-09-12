import { createCctvCatalog } from './cctv/catalog.js';
import {
  normalizeFeedType,
  isVideoFeedType,
  toFiniteNumber,
} from './cctv/normalize.js';
import {
  buildSyntheticCctvSvg,
  proxyMediaResponse,
  fetchCctvImageFromUpstream,
} from './cctv/media.js';
import { CCTV_FRAME_FETCH_TIMEOUT_MS } from './cctv/constants.js';
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
 *   GET /api/cctv/media/:id      — proxy live video/image media from upstream
 *   GET /api/cctv/frame/:id      — single frame with fallback chain
 *
 * @returns {import('vite').Plugin}
 */
export function cctvProxy({ sourceRoot = process.cwd() } = {}) {
  const getCctvSources = createCctvCatalog({ sourceRoot });
  /** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
  const health = new Map();
  /** Cap on health map entries to prevent unbounded growth. Sized to cover the
   * full served catalog (CCTV_MAX_SOURCES hard-bounds at 1200) so health/status
   * observability isn't silently evicted for a default 800-camera catalog. */
  const HEALTH_MAX_ENTRIES = 1200;

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
      const svType = svResp.headers.get('content-type') || '';
      if (!svResp.ok || !svType.startsWith('image/')) return null;

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
    server.middlewares.use('/api/cctv', async (req, res) => {
      try {
        const sources = await getCctvSources();
        const sourceById = new Map(
          sources.map((source) => [source.id, source]),
        );
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
              sourceKind:
                source.sourceKind || (source.url ? 'configured' : 'fallback'),
              poseSource: source.poseSource,
              license: source.license,
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
          const cameraId =
            decodeURIComponent(url.pathname.replace('/media/', '').trim()) ||
            'camera';
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

          try {
            const upstreamHeaders = {
              'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
            };
            const requestRange = req.headers?.range;
            if (requestRange) upstreamHeaders.Range = requestRange;
            const upstream = await fetch(mediaUrl, {
              headers: upstreamHeaders,
            });
            const contentType = upstream.headers.get('content-type') || '';
            if (!upstream.ok) {
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

            if (
              isVideoFeedType(feedType) &&
              !(
                contentType.startsWith('video/') ||
                contentType.includes('mpegurl')
              )
            ) {
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
                message: isVideoFeedType(feedType)
                  ? 'Live stream connected'
                  : 'Snapshot feed connected',
              });
            }

            await proxyMediaResponse(res, upstream, {
              sourceHeader: isVideoFeedType(feedType)
                ? 'live-media'
                : 'upstream-image',
            });
            return;
          } catch (error) {
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'upstream',
              label: source?.provider || 'Configured source',
              message: error?.message || 'Media fetch failed',
            });
            res.writeHead(502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ error: 'Media proxy failed' }));
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
          await fetchCctvImageFromUpstream(upstreamCandidate);
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

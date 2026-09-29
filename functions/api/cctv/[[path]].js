// functions/api/cctv/[[path]].js
/**
 * `/api/cctv/*` — Cloudflare Pages Function (catch-all).
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (cctvProxy), which is only reachable under `vite dev`. Without this
 * Function the deployed site 404s on every CCTV route and the camera panel
 * renders no frames at all.
 *
 * The whole subsystem — catalog assembly, feed types, health tracker, and the
 * upstream → Street View → synthetic fallback chain — lives in the shared
 * `src/data/cctvSources.js` module, the same module the dev middleware uses,
 * so a dev request and a production request see the same camera catalog and
 * the same bytes for a given frame. What this Function adds is only the
 * Workers plumbing: a web `Response` instead of a Node `res`, streaming media
 * passthrough, and env from the `env` binding instead of `process.env`.
 *
 * Contract (identical to dev):
 *   GET /api/cctv/sources     → 200 { sources: [...] }              (no-store)
 *   GET /api/cctv/health      → 200 { cameras: [...] }              (no-store)
 *   GET /api/cctv/stream/:id  → 200 { id, feedType, mediaUrl,
 *                                     frameUrl, provider, sourceKind }
 *   GET /api/cctv/media/:id   → passthrough of the upstream media body
 *                               (Range forwarded, Content-* and Cache-Control
 *                               mirrored, X-CCTV-Source live-media|upstream-image)
 *                             → 404 { error: 'No media URL configured for this camera' }
 *                             → <upstream status> { error: 'Upstream returned N' }
 *                             → 502 { error: 'Media proxy failed' }
 *                             → 502 { error: 'Upstream media exceeds size cap' }
 *   GET /api/cctv/frame/:id   → 200 image with X-CCTV-Source:
 *                               'upstream-image' | 'streetview' | 'synthetic'
 *   anything else             → 404 { error: 'not found' }
 *   internal error            → 500 { error: 'CCTV proxy error' }
 *
 * Methods: the dev middleware is mounted with `server.middlewares.use` and
 * never inspects `req.method`, so this Function deliberately does not 405
 * either — GET and everything else behave exactly as dev does.
 *
 * SSRF: only server-registered upstream URLs are ever fetched (open-data pack,
 * config file, `CCTV_SOURCES_JSON`). No client-supplied URL, including a
 * `?upstream=` query parameter, is ever honored.
 *
 * Env: CCTV_SOURCES_JSON (optional inline JSON catalog — the only configured
 *      source available here, since Workers have no filesystem),
 *      CCTV_FORCE_AUSTIN, CCTV_PREFER_AUSTIN, CCTV_TFL_ENABLED,
 *      CCTV_MAX_SOURCES, CCTV_AUSTIN_ROWS_URL, CCTV_AUSTIN_MAX_SOURCES,
 *      CCTV_CALTRANS_DISTRICTS, CCTV_CALTRANS_MAX_SOURCES,
 *      CCTV_TFL_MAX_SOURCES, TFL_APP_KEY, GOOGLE_MAPS_API_KEY (enables the
 *      Street View fallback tier).
 *
 * Catalog and health state are per-isolate (same honesty as `functions/_lib.js`).
 */
import {
  MEDIA_DECLARED_CAP_BYTES,
  buildMediaPassthrough,
  buildStreamPayload,
  buildSyntheticCctvSvg,
  createCctvHealthTracker,
  fetchCctvImageFromUpstream,
  fetchMediaHeadersBounded,
  getCctvSources,
  isVideoFeedType,
  normalizeFeedType,
  parseConfiguredSourcesFromEnv,
  streetViewFallback,
} from '../../../src/data/cctvSources.js';
import { safeRangeHeader } from '../../../src/data/externalUrlPolicy.js';
import { resolveServerGoogleApiKey } from '../../../src/data/googlePlacesPolicy.js';
import { jsonResponse } from '../../_lib.js';

/** Created once per isolate so health entries survive across requests. */
const cctvHealth = createCctvHealthTracker();

/**
 * Recover the dev middleware's view of the path. Dev mounts on `/api/cctv`, so
 * `req.url` there is already the sub-path; here the full origin path is
 * stripped of the same prefix, still URL-encoded, so the `decodeURIComponent`
 * calls below see byte-identical input.
 *
 * @param {string} pathname
 * @returns {string}
 */
function subPath(pathname) {
  return pathname.startsWith('/api/cctv') ? pathname.slice('/api/cctv'.length) || '/' : pathname;
}

export async function onRequest(context) {
  const { request } = context;
  const env = context.env || {};
  try {
    // Production has no filesystem, so the configured catalog is env-only; the
    // dev middleware additionally injects config/cctv_sources.austin.json.
    const sources = await getCctvSources({
      configuredSources: parseConfiguredSourcesFromEnv(env.CCTV_SOURCES_JSON),
      env,
    });
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const url = new URL(request.url);
    const pathname = subPath(url.pathname);

    if (pathname === '/sources') {
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
      return jsonResponse(body, { cacheControl: 'no-store' });
    }

    if (pathname === '/health') {
      return jsonResponse({ cameras: cctvHealth.listHealth() }, { cacheControl: 'no-store' });
    }

    if (pathname.startsWith('/stream/')) {
      const cameraId = decodeURIComponent(pathname.replace('/stream/', '').trim()) || 'camera';
      const source = sourceById.get(cameraId);
      return jsonResponse(buildStreamPayload(source, cameraId), { cacheControl: 'no-store' });
    }

    if (pathname.startsWith('/media/')) {
      const cameraId = decodeURIComponent(pathname.replace('/media/', '').trim()) || 'camera';
      const source = sourceById.get(cameraId);
      const mediaUrl = source?.url || '';
      const feedType = normalizeFeedType(source?.feedType || 'image');

      if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
        cctvHealth.setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'fallback',
          label: source?.provider || 'No upstream URL',
          message: 'No stream URL configured',
        });
        return jsonResponse(
          { error: 'No media URL configured for this camera' },
          { status: 404, cacheControl: 'no-store' },
        );
      }

      try {
        const upstreamHeaders = { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' };
        // Forward only a well-formed byte range; anything else is dropped
        // and the upstream serves the full body (issue #27).
        // Bounded ask: an accepted Range is clamped to the same span ceiling the
        // passthrough applies to a declared body (ported from upstream).
        const requestRange = safeRangeHeader(request.headers.get('range'), MEDIA_DECLARED_CAP_BYTES);
        if (requestRange) upstreamHeaders.Range = requestRange;
        // Bounded wait for response headers (issue #25); disarmed below once
        // we take the body so a healthy unbounded stream is never killed.
        const media = await fetchMediaHeadersBounded(mediaUrl, { headers: upstreamHeaders });
        if (!media.ok) throw new Error('Media upstream timed out');
        const upstream = media.upstream;
        media.disarm();
        const contentType = upstream.headers.get('content-type') || '';
        if (!upstream.ok) {
          cctvHealth.setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'upstream',
            label: source?.provider || 'Configured source',
            message: `Upstream HTTP ${upstream.status}`,
          });
          return jsonResponse(
            { error: `Upstream returned ${upstream.status}` },
            { status: upstream.status, cacheControl: 'no-store' },
          );
        }

        if (isVideoFeedType(feedType) && !(contentType.startsWith('video/') || contentType.includes('mpegurl'))) {
          cctvHealth.setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'upstream',
            label: source?.provider || 'Configured source',
            message: `Unexpected media type ${contentType || 'unknown'}`,
          });
        } else {
          cctvHealth.setHealth(cameraId, {
            status: 'ok',
            sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
            label: source?.provider || 'Configured source',
            message: isVideoFeedType(feedType) ? 'Live stream connected' : 'Snapshot feed connected',
          });
        }

        const passthrough = buildMediaPassthrough(upstream, {
          sourceHeader: isVideoFeedType(feedType) ? 'live-media' : 'upstream-image',
        });
        if (!passthrough.ok) {
          try { await upstream.body?.cancel(); } catch { /* no-op */ }
          return jsonResponse(
            { error: passthrough.error },
            { status: passthrough.status, cacheControl: 'no-store' },
          );
        }

        // Stream the upstream body straight through (Range included) instead of
        // buffering — live MJPEG/HLS never ends, so buffering would hang.
        return new Response(upstream.body, {
          status: passthrough.status,
          headers: passthrough.headers,
        });
      } catch (error) {
        // Only our own controlled timeout sentinel reaches the health
        // message; raw network error text (errno, hostnames) stays
        // server-side (Pages log) — the UI renders a fixed string
        // (dev/Pages parity — ported from upstream).
        const timedOut = error?.message === 'Media upstream timed out';
        if (!timedOut) {
          console.warn(`[cctv] media fetch failed for ${cameraId}: ${error?.message}`);
        }
        cctvHealth.setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'upstream',
          label: source?.provider || 'Configured source',
          message: timedOut ? 'Media upstream timed out' : 'Media fetch failed',
        });
        return jsonResponse({ error: 'Media proxy failed' }, { status: 502, cacheControl: 'no-store' });
      }
    }

    if (!pathname.startsWith('/frame/')) {
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }

    const cameraId = decodeURIComponent(pathname.replace('/frame/', '').trim()) || 'camera';
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
      cctvHealth.setHealth(cameraId, {
        status: 'ok',
        sourceKind: 'snapshot',
        label: source?.provider || 'Configured source',
        message: 'Upstream snapshot active',
      });
      return new Response(upstreamImage.body, {
        status: 200,
        headers: {
          'Content-Type': upstreamImage.contentType,
          'Cache-Control': 'no-store',
          'X-CCTV-Source': 'upstream-image',
        },
      });
    }

    const sv = await streetViewFallback({
      lat,
      lon,
      heading,
      fov,
      pitch,
      apiKey: resolveServerGoogleApiKey(env),
    });
    if (sv?.ok) {
      cctvHealth.setHealth(cameraId, {
        status: 'degraded',
        sourceKind: 'streetview',
        label: 'Google Street View',
        message: 'Fallback Street View frame',
      });
      return new Response(sv.body, {
        status: 200,
        headers: {
          'Content-Type': sv.contentType,
          'Cache-Control': 'no-store',
          'X-CCTV-Source': 'streetview',
        },
      });
    }

    const svg = buildSyntheticCctvSvg({
      cameraId,
      label,
      city,
      status: source?.url ? 'UPSTREAM UNAVAILABLE' : 'NO UPSTREAM CONFIGURED',
    });

    cctvHealth.setHealth(cameraId, {
      status: 'degraded',
      sourceKind: 'synthetic',
      label: source?.provider || 'Synthetic fallback',
      message: source?.url ? 'Upstream unavailable' : 'No source configured',
    });

    return new Response(svg, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-store',
        'X-CCTV-Source': 'synthetic',
      },
    });
  } catch (error) {
    console.error('[CCTV Proxy]', error?.message || String(error));
    return jsonResponse({ error: 'CCTV proxy error' }, { status: 500 });
  }
}

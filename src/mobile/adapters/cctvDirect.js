import {
  UPSTREAM_NOT_ALLOWED,
  createPacer,
  isUpstreamRefusal,
} from '../sourcePolicy.js';

/**
 * On-device CCTV: direct camera frame/media access with in-memory HLS leases.
 *
 * Self-contained port of the server's `server/providers/cctv/media.js` and
 * `server/providers/cctv/stream.js` (canonical pointers are kept on each
 * helper). The server modules use `node:stream` and `node:crypto`; this file
 * is Web-API-only (fetch Response.body, Uint8Array, TextEncoder, atob,
 * crypto.randomUUID) so `check:boundaries` stays green.
 *
 * - TxDOT snapshot decode (base64 JPEG in JSON envelope)
 * - Generic image fetch with same-host redirect guard
 * - HLS puller with 15 s abandoned-lease expiry (in-memory Map, no server)
 * - Synthetic SVG fallback (Street View fallback OMITTED on-device: needs a
 *   server-side key, so on-device builds skip straight to synthetic)
 *
 * Camera catalog comes from bundled registry (mirror of server's CCTV catalogs).
 *
 * @module mobile/adapters/cctvDirect
 */

const DEFAULT_FRAME_TIMEOUT_MS = 8_000;
const DEFAULT_FRAME_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_PACER_INTERVAL_MS = 2_000; // Courtesy between frame fetches

/** Pinned TxDOT snapshot endpoint (origin + path pin holds: no redirects). */
const TXDOT_SNAPSHOT_ORIGIN = 'https://its.txdot.gov';
const TXDOT_SNAPSHOT_PATH = '/its/DistrictIts/GetCctvSnapshotByIcdId';

/** Max same-host redirect hops for generic image fetches. */
const MAX_SAME_HOST_REDIRECTS = 2;

/**
 * The NSW webcam host answers non-browser clients with HTTP 200 and a short
 * HTML body instead of the frame, so that one host gets a browser UA.
 * Canonical implementation: server/providers/cctv/media.js.
 */
const NSW_IMAGE_HOST = 'webcams.transport.nsw.gov.au';
const NSW_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CCTV_PROXY_USER_AGENT = 'gods-eye-view-cctv-proxy/1.0';

/** Bundled CCTV camera registry (subset of server catalogs, loaded at build time). */
let CCTV_CATALOG = [];

/**
 * Set the bundled CCTV catalog (called at app init with preloaded data).
 * @param {Array<object>} catalog
 */
export function setCctvCatalog(catalog) {
  CCTV_CATALOG = Array.isArray(catalog) ? catalog : [];
}

/**
 * Get camera by id from bundled catalog.
 * @param {string} cameraId
 * @returns {object|null}
 */
function getCamera(cameraId) {
  return CCTV_CATALOG.find((c) => c.id === cameraId) || null;
}

/**
 * Create the on-device CCTV direct source.
 * @param {{ fetchImpl?: Function, pacer?: { wait: Function }, hlsPuller?: ReturnType<typeof createHlsPuller> }} options
 * @returns {{ getFrame: Function, getMedia: Function, getStreamInfo: Function, getCatalog: Function, releaseLease: Function }}
 */
export function createCctvDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  pacer = createPacer(DEFAULT_PACER_INTERVAL_MS),
  hlsPuller = createHlsPuller(),
} = {}) {
  const inFlight = new Map();

  /**
   * Get a single frame for a camera (with fallback chain: upstream → synthetic).
   * Street View fallback is OMITTED on-device — see note in synthetic fallback.
   * @param {string} cameraId
   * @param {{ signal?: AbortSignal }} options
   * @returns {Promise<{ ok: boolean, body?: Uint8Array, contentType?: string, source: string }>}
   */
  async function getFrame(cameraId, { signal } = {}) {
    const camera = getCamera(cameraId);
    if (!camera) throw new Error(`Unknown camera: ${cameraId}`);

    const key = `frame:${cameraId}`;
    let inflight = inFlight.get(key);
    if (!inflight) {
      inflight = (async () => {
        try {
          await pacer.wait({ signal });
          signal?.throwIfAborted();

          // 1. Try upstream snapshot
          const upstreamUrl =
            camera.snapshotUrl ||
            (!camera.feedType || camera.feedType === 'image' ? camera.url : '');
          if (upstreamUrl) {
            if (camera.sourceKind === 'txdot-its') {
              const result = await fetchTxdotSnapshot(upstreamUrl, {
                fetchImpl,
                timeoutMs: DEFAULT_FRAME_TIMEOUT_MS,
                maxBytes: DEFAULT_FRAME_MAX_BYTES,
              });
              if (result?.ok) {
                return {
                  ok: true,
                  body: result.body,
                  contentType: result.contentType,
                  source: 'upstream-image',
                };
              }
            } else {
              const result = await fetchCctvImageFromUpstream(upstreamUrl, {
                fetchImpl,
                timeoutMs: DEFAULT_FRAME_TIMEOUT_MS,
                maxBytes: DEFAULT_FRAME_MAX_BYTES,
              });
              if (result?.ok) {
                return {
                  ok: true,
                  body: result.body,
                  contentType: result.contentType,
                  source: 'upstream-image',
                };
              }
            }
          }

          // 2. Street View fallback — OMITTED on-device (needs server key)
          // Note: On-device builds cannot use Street View Static API without a server-side key.
          // The server proxy handles this fallback; on-device we skip to synthetic.

          // 3. Synthetic SVG fallback (honest placeholder)
          const svg = buildSyntheticCctvSvg({
            cameraId,
            label: camera.name || cameraId,
            city: camera.city || '',
            status: upstreamUrl
              ? 'UPSTREAM UNAVAILABLE'
              : 'NO UPSTREAM CONFIGURED',
          });
          return {
            ok: true,
            body: new TextEncoder().encode(svg),
            contentType: 'image/svg+xml',
            source: 'synthetic',
          };
        } catch (error) {
          if (isUpstreamRefusal(error)) {
            return { unavailable: UPSTREAM_NOT_ALLOWED };
          }
          throw error;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, inflight);
    }

    return inflight;
  }

  /**
   * Get HLS stream info for a camera.
   * @param {string} cameraId
   * @returns {{ feedType: string, mediaUrl: string|null, frameUrl: string, provider: string, sourceKind: string }}
   */
  function getStreamInfo(cameraId) {
    const camera = getCamera(cameraId);
    if (!camera) throw new Error(`Unknown camera: ${cameraId}`);

    const feedType = camera.feedType || 'image';
    const isVideo = feedType === 'hls' || feedType === 'mjpeg';

    return {
      id: cameraId,
      feedType,
      mediaUrl: isVideo
        ? `/api/cctv/media/${encodeURIComponent(cameraId)}`
        : null,
      frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
      provider: camera.provider || '',
      sourceKind: camera.sourceKind || (camera.url ? 'configured' : 'fallback'),
    };
  }

  /**
   * Get HLS media (playlist or segment) for a camera.
   * Creates/uses an in-memory lease (15 s abandoned expiry).
   * @param {string} cameraId
   * @param {{ leaseId?: string, sessionId?: string, segment?: number, signal?: AbortSignal }} options
   * @returns {Promise<{ playlist?: string, segment?: Uint8Array, contentType: string, sessionId?: string, leaseId?: string }>}
   */
  async function getMedia(
    cameraId,
    { leaseId, sessionId, segment, signal } = {},
  ) {
    const camera = getCamera(cameraId);
    if (!camera) throw new Error(`Unknown camera: ${cameraId}`);
    if (!camera.url || !camera.url.includes('.m3u8')) {
      throw new Error('Not an HLS stream');
    }

    // Create or reuse lease
    const lease =
      leaseId || `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `media:${cameraId}:${lease}`;

    let inflight = inFlight.get(key);
    if (!inflight) {
      inflight = (async () => {
        try {
          await pacer.wait({ signal });
          signal?.throwIfAborted();

          // Ensure HLS puller has the stream
          const entry = await hlsPuller.ensure(cameraId, camera.url, lease);
          if (!entry) throw new Error('HLS stream unavailable');

          if (segment !== undefined) {
            // Return specific segment
            const seg = hlsPuller.getSegment(
              cameraId,
              sessionId,
              segment,
              lease,
            );
            if (!seg) throw new Error('Segment not found');
            return { segment: seg, contentType: 'video/mp2t' };
          }

          // Wait for playlist to be ready
          await hlsPuller.waitReady(entry, signal);
          const playlist = await hlsPuller.buildPlaylist(
            entry,
            cameraId,
            lease,
          );
          if (!playlist) throw new Error('HLS playlist unavailable');

          return {
            playlist,
            contentType: 'application/vnd.apple.mpegurl',
            sessionId: entry.token,
            leaseId: lease,
          };
        } catch (error) {
          if (isUpstreamRefusal(error)) {
            return { unavailable: UPSTREAM_NOT_ALLOWED };
          }
          throw error;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, inflight);
    }

    return inflight;
  }

  /**
   * Release an HLS lease.
   * @param {string} cameraId
   * @param {string} leaseId
   */
  function releaseLease(cameraId, leaseId) {
    hlsPuller.release(cameraId, leaseId);
  }

  /**
   * Get the full camera catalog.
   * @returns {Promise<Array<object>>}
   */
  async function getCatalog() {
    return CCTV_CATALOG.map((c) => ({
      id: c.id,
      pack: c.pack,
      name: c.name,
      city: c.city,
      cityId: c.cityId,
      provider: c.provider,
      lat: c.lat,
      lon: c.lon,
      headingDeg: c.headingDeg,
      headingConfidence: c.headingConfidence || '',
      pitchDeg: c.pitchDeg,
      fovDeg: c.fovDeg,
      rangeM: c.rangeM,
      mountHeightM: c.mountHeightM,
      groundElevationM: c.groundElevationM,
      feedType: c.feedType,
      sourceKind: c.sourceKind || (c.url ? 'configured' : 'fallback'),
      poseSource: c.poseSource,
      license: c.license,
      credit: c.credit || '',
      code: c.code || '',
      groundHeights: c.groundHeights || null,
    }));
  }

  return { getFrame, getMedia, getStreamInfo, getCatalog, releaseLease };
}

// ---------------------------------------------------------------------------
// Ported from server/providers/cctv/normalize.js (pure, Node-free).
// Canonical pointer: server/providers/cctv/normalize.js
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash of a string, used to derive deterministic pseudo-random
 * values (e.g. hue for synthetic SVG billboards).
 * @param {string} text
 * @returns {number} Unsigned 32-bit hash.
 */
function hashSeed(text) {
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/**
 * Escape special XML/HTML characters for safe embedding in SVG text nodes.
 * @param {*} text
 * @returns {string}
 */
function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Ported from server/providers/cctv/media.js (Web-API-only: no node:stream).
// Canonical pointer: server/providers/cctv/media.js
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic SVG billboard image for a CCTV camera placeholder.
 * @param {object} opts
 * @param {string} opts.cameraId
 * @param {string} opts.label
 * @param {string} [opts.city]
 * @param {string} [opts.status]
 * @returns {string} SVG markup string.
 */
export function buildSyntheticCctvSvg({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace('Z', 'Z').slice(0, 20);
  const safeLabel = escapeXml(label);
  const safeCity = escapeXml(city || 'GLOBAL GRID');
  const safeId = escapeXml(cameraId);
  const safeStatus = escapeXml(status || 'SYNTHETIC');

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <radialGradient id="flare" cx="0.22" cy="0.24" r="0.78">
      <stop offset="0%" stop-color="hsla(${hue2}, 100%, 65%, 0.35)" />
      <stop offset="100%" stop-color="hsla(${hue2}, 100%, 40%, 0)" />
    </radialGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#flare)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g stroke="rgba(123,233,255,0.25)" stroke-width="1" fill="none">
    <path d="M60 460 Q300 300 520 420 T900 320" />
    <path d="M100 160 Q340 40 620 130 T920 90" />
    <path d="M20 280 Q220 230 390 270 T760 250" />
  </g>
  <g fill="none" stroke="rgba(180,248,255,0.2)" stroke-width="1">
    <rect x="70" y="80" width="820" height="380" rx="8" />
    <line x1="70" y1="270" x2="890" y2="270" />
    <line x1="480" y1="80" x2="480" y2="460" />
  </g>
  <g fill="#9cefff" font-family="JetBrains Mono, monospace" text-transform="uppercase">
    <text x="74" y="54" font-size="16" letter-spacing="2">CCTV FEED PLACEHOLDER</text>
    <text x="74" y="512" font-size="14" letter-spacing="1.5">${safeLabel} · ${safeCity}</text>
    <text x="646" y="512" font-size="13" letter-spacing="1.2">${safeId}</text>
    <text x="704" y="54" font-size="15" letter-spacing="2">${escapeXml(ts)}</text>
    <text x="74" y="486" font-size="13" letter-spacing="1.3">${safeStatus}</text>
  </g>
</svg>`.trim();
}

/**
 * Read a snapshot incrementally into an owned Uint8Array (at most maxBytes).
 * Every retained chunk is an OWNED copy: a chunk can be a small view over a
 * much larger backing ArrayBuffer, and keeping the view would retain that
 * whole allocation while the byte accounting only counted the view.
 * @param {Response} upstream
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array|null>} Bytes, or null when over the cap.
 */
async function readCappedResponseBytes(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return null;
  }
  if (!upstream.body) return null;
  const chunks = [];
  let total = 0;
  // Web-API-only: async iteration works on web ReadableStreams; fall back to
  // an explicit reader where it does not.
  const keep = (chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) return false;
    chunks.push(chunk.slice());
    return true;
  };
  if (typeof upstream.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of upstream.body) {
      if (!keep(chunk)) {
        try {
          await upstream.body.cancel();
        } catch {
          /* no-op */
        }
        return null;
      }
    }
  } else if (typeof upstream.body.getReader === 'function') {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!keep(value)) {
          try {
            await reader.cancel();
          } catch {
            /* already closed */
          }
          return null;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    return null;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Decode canonical base64 into bytes using only Web APIs (no Buffer).
 * The caller pre-validates the canonical alphabet, so atob cannot throw.
 * @param {string} snippet Canonical base64 (no data: prefix).
 * @returns {Uint8Array}
 */
function base64ToBytes(snippet) {
  const binary = atob(snippet);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    result[i] = binary.charCodeAt(i);
  }
  return result;
}

/**
 * Fetch and decode a TxDOT ITS / TransGuide snapshot.
 *
 * TxDOT returns JSON with a base64-encoded JPEG in `snippet`, rather than
 * returning image/jpeg directly.
 * @param {string} url
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Fetch implementation.
 * @param {number} [options.timeoutMs] Abort timeout.
 * @param {number} [options.maxBytes] Snapshot byte cap.
 * @returns {Promise<{ok:true,body:Uint8Array,contentType:string}|null>}
 */
export async function fetchTxdotSnapshot(
  url,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
    maxBytes = DEFAULT_FRAME_MAX_BYTES,
  } = {},
) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.origin !== TXDOT_SNAPSHOT_ORIGIN ||
    parsed.pathname !== TXDOT_SNAPSHOT_PATH
  ) {
    return null;
  }
  // Base64 inflates by 4/3; the JSON envelope adds a few bytes of framing.
  const maxEnvelopeBytes = Math.ceil((maxBytes * 4) / 3) + 4096;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The snapshot endpoint answers directly; a redirect is not followed, so
    // the origin/path pin above holds for the request that is actually made.
    const upstream = await fetchImpl(parsed.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': CCTV_PROXY_USER_AGENT,
      },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!upstream.ok) return null;
    const envelope = await readCappedResponseBytes(upstream, maxEnvelopeBytes);
    if (!envelope) return null;
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(envelope));
    } catch {
      return null;
    }
    let snippet =
      typeof payload?.snippet === 'string' ? payload.snippet.trim() : '';
    if (!snippet) return null;
    snippet = snippet.replace(/^data:image\/jpeg;base64,/i, '');
    // Canonical base64 only (4-char groups, padding only at the end):
    // atob() tolerates some junk, which would let a non-image body decode
    // into "something".
    if (
      snippet.length > maxEnvelopeBytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        snippet,
      )
    ) {
      return null;
    }
    const body = base64ToBytes(snippet);
    if (body.length < 4 || body.length > maxBytes) return null;
    if (body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return null;
    return { ok: true, body, contentType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}

/**
 * Fetch a registered frame URL following redirects ONLY within the original
 * origin (scheme, host and port; at most MAX_SAME_HOST_REDIRECTS hops).
 * Default redirect-following would let an upstream steer a host-pinned
 * request, and its host-specific headers, to any origin, another port, or a
 * plaintext downgrade.
 * @param {string} url
 * @param {object} init fetch init (headers, signal).
 * @param {Function} fetchImpl
 * @returns {Promise<Response|null>} Final response, or null on an off-host or
 *   over-long redirect chain.
 */
export async function fetchWithinHost(
  url,
  init,
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  let current;
  try {
    current = new URL(url);
  } catch {
    return null;
  }
  const origin = current.origin;
  for (let hop = 0; hop <= MAX_SAME_HOST_REDIRECTS; hop++) {
    const upstream = await fetchImpl(current.toString(), {
      ...init,
      redirect: 'manual',
    });
    // Anything that is not a 3xx (including a test double with no status) is
    // the final answer.
    const status = Number(upstream?.status);
    if (!(status >= 300 && status < 400)) return upstream;
    const location = upstream.headers.get('location');
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    if (!location || hop === MAX_SAME_HOST_REDIRECTS) return null;
    let next;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (next.origin !== origin) return null;
    current = next;
  }
  return null;
}

/**
 * User-Agent for one upstream frame request.
 * @param {string} url
 * @returns {string}
 */
export function cctvUpstreamUserAgent(url) {
  try {
    return new URL(url).hostname === NSW_IMAGE_HOST
      ? NSW_IMAGE_USER_AGENT
      : CCTV_PROXY_USER_AGENT;
  } catch {
    return CCTV_PROXY_USER_AGENT;
  }
}

/**
 * Fetch one upstream CCTV image within the frame-refresh budget.
 *
 * A timeout is treated like every other upstream miss so the caller can
 * continue through to the synthetic fallback chain.
 * @param {string} url Server-registered upstream image URL.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Fetch implementation.
 * @param {number} [options.timeoutMs] Abort timeout.
 * @param {number} [options.maxBytes] Snapshot byte cap.
 * @returns {Promise<{ok:true,body:Uint8Array,contentType:string}|null>}
 */
export async function fetchCctvImageFromUpstream(
  url,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
    maxBytes = DEFAULT_FRAME_MAX_BYTES,
  } = {},
) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DOMException('CCTV upstream frame fetch timed out', 'TimeoutError'),
    );
  }, timeoutMs);
  try {
    const upstream = await fetchWithinHost(
      url,
      {
        headers: { 'User-Agent': cctvUpstreamUserAgent(url) },
        signal: controller.signal,
      },
      fetchImpl,
    );
    if (!upstream) return null;
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      controller.abort();
      return null;
    }
    const body = await readCappedResponseBytes(upstream, maxBytes);
    if (!body) return null;
    return { ok: true, body, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Ported from server/providers/cctv/stream.js (Web-API-only: no node:crypto).
// Canonical pointer: server/providers/cctv/stream.js
// ---------------------------------------------------------------------------

/** Bounded, demand-owned HLS sessions. No subprocess, disk cache or idle sweep. */
export const HLS_LIMITS = Object.freeze({
  sessions: 2,
  leasesPerSession: 8,
  playlistBytes: 256 * 1024,
  segmentBytes: 4 * 1024 * 1024,
  sessionBytes: 24 * 1024 * 1024,
  segments: 12,
  pollMs: 2000,
  idleMs: 15000,
  timeoutMs: 10000,
  readyMs: 12000,
});

/** New session/lease token (Web-API-only; falls back off crypto.randomUUID). */
function newHlsToken() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid) return uuid;
  } catch {
    /* fall through to Math.random */
  }
  return `hls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Refuse redirects; count actual streamed bytes, including chunked responses.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Uint8Array>}
 */
export async function fetchHlsBytes(
  url,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    signal,
    maxBytes,
    timeoutMs = HLS_LIMITS.timeoutMs,
  } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let reader;
  let response;
  try {
    controller.signal.throwIfAborted();
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { 'User-Agent': CCTV_PROXY_USER_AGENT },
    });
    if (
      !response.ok ||
      response.redirected ||
      (response.url && new URL(response.url).href !== new URL(url).href)
    )
      throw new Error('HLS upstream refused');
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('HLS response too large');
    reader = response.body?.getReader?.();
    if (!reader) throw new Error('HLS response is not streamable');
    const chunks = [];
    let length = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('HLS response too large');
      chunks.push(value.slice());
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else await response?.body?.cancel().catch(() => {});
    reader?.releaseLock();
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Pin an HLS reference inside its registered origin (no creds, http/https).
 * @param {string} value
 * @param {string} base
 * @returns {string}
 */
export function sameOriginHlsUrl(value, base) {
  const url = new URL(value, base);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.origin !== new URL(base).origin ||
    url.username ||
    url.password
  )
    throw new Error('HLS reference escapes registered origin');
  return url.href;
}

/**
 * Only clear MPEG-TS media playlists: encrypted, fMP4 and byte ranges fail closed.
 * @param {string} text
 * @param {string} base
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function parseHlsMedia(text, base, limit = HLS_LIMITS.segments) {
  if (
    !text.startsWith('#EXTM3U') ||
    /#EXT-X-(?:KEY|MAP|BYTERANGE|I-FRAMES-ONLY)/.test(text)
  )
    throw new Error('Unsupported HLS playlist');
  let seq = 0;
  let duration = null;
  let discontinuity = false;
  const segments = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.slice(22));
      if (!Number.isSafeInteger(seq) || seq < 0)
        throw new Error('Invalid media sequence');
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice(8));
      if (!Number.isFinite(duration) || duration <= 0 || duration > 60)
        throw new Error('Invalid segment duration');
    } else if (line && !line.startsWith('#')) {
      if (duration === null || !Number.isSafeInteger(seq))
        throw new Error('Invalid HLS segment');
      const uri = sameOriginHlsUrl(line, base);
      if (!new URL(uri).pathname.endsWith('.ts'))
        throw new Error('Only MPEG-TS segments are supported');
      segments.push({ seq: seq++, duration, uri, discontinuity });
      discontinuity = false;
      duration = null;
    }
  }
  return segments.slice(-limit);
}

/**
 * Create an in-memory HLS puller with 15 s abandoned-lease expiry.
 * @param {{ fetchImpl?: Function, limits?: object }} options
 * @returns {{ ensure: Function, waitReady: Function, buildPlaylist: Function, getSegment: Function, stop: Function, release: Function, shutdown: Function, stats: Function }}
 */
export function createHlsPuller({
  fetchImpl = (...args) => globalThis.fetch(...args),
  limits = HLS_LIMITS,
} = {}) {
  const active = new Map();
  let closed = false;
  const stop = (cameraId, token) => {
    const entry = active.get(cameraId);
    if (!entry || (token && token !== entry.token)) return;
    active.delete(cameraId);
    entry.stopping = true;
    entry.controller.abort();
    clearTimeout(entry.timer);
    for (const lease of entry.leases.values()) clearTimeout(lease.timer);
    entry.leases.clear();
    entry.segments.clear();
    entry.upstream.clear();
    entry.bytes = 0;
  };
  const release = (cameraId, leaseId) => {
    const entry = active.get(cameraId);
    const lease = entry?.leases.get(leaseId);
    if (!lease) return;
    clearTimeout(lease.timer);
    entry.leases.delete(leaseId);
    if (!entry.leases.size) stop(cameraId, entry.token);
  };
  const touch = (entry, leaseId, create = false) => {
    let lease = entry.leases.get(leaseId);
    if (!lease) {
      if (!create || entry.leases.size >= limits.leasesPerSession)
        throw new Error('HLS lease capacity reached');
      lease = {};
      entry.leases.set(leaseId, lease);
    }
    clearTimeout(lease.timer);
    lease.timer = setTimeout(
      () => release(entry.cameraId, leaseId),
      limits.idleMs,
    );
    lease.timer.unref?.();
  };
  const read = (entry, url, maxBytes) =>
    fetchHlsBytes(url, {
      fetchImpl,
      signal: entry.controller.signal,
      maxBytes,
      timeoutMs: limits.timeoutMs,
    });
  const poll = async (entry) => {
    try {
      let base = entry.chunklistUrl || entry.url;
      let text = new TextDecoder().decode(
        await read(entry, base, limits.playlistBytes),
      );
      if (!text.includes('#EXTINF:')) {
        const variant = text
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith('#'));
        if (!variant || !text.includes('#EXT-X-STREAM-INF:'))
          throw new Error('Missing HLS variant');
        base = sameOriginHlsUrl(variant, entry.url);
        text = new TextDecoder().decode(
          await read(entry, base, limits.playlistBytes),
        );
      }
      entry.chunklistUrl = base;
      const segments = parseHlsMedia(text, base, limits.segments);
      const newest = segments.at(-1)?.seq ?? -1;
      const restarted =
        newest < entry.upstreamNewest ||
        segments.some((segment) => {
          const prior = entry.upstream.get(segment.seq);
          return prior && prior !== segment.uri;
        });
      if (restarted) {
        entry.upstream.clear();
        entry.pendingDiscontinuity = true;
      }
      entry.upstreamNewest = newest;
      for (const segment of segments) {
        if (entry.stopping) return;
        if (entry.upstream.has(segment.seq)) continue;
        const body = await read(entry, segment.uri, limits.segmentBytes);
        if (entry.stopping) return;
        // Evict BEFORE retaining the incoming segment. One bounded download may
        // exist in addition to the cache; no unbounded disk output is possible.
        while (
          entry.segments.size &&
          (entry.bytes + body.length > limits.sessionBytes ||
            entry.segments.size >= limits.segments)
        ) {
          const oldest = entry.segments.keys().next().value;
          const removed = entry.segments.get(oldest);
          entry.bytes -= removed.body.length;
          if (removed.discontinuity) entry.discontinuitiesRemoved++;
          entry.segments.delete(oldest);
        }
        if (body.length > limits.sessionBytes)
          throw new Error('Segment exceeds session budget');
        const seq = entry.nextSeq++;
        entry.segments.set(seq, {
          ...segment,
          seq,
          body,
          discontinuity: segment.discontinuity || entry.pendingDiscontinuity,
        });
        entry.pendingDiscontinuity = false;
        entry.upstream.set(segment.seq, segment.uri);
        while (entry.upstream.size > limits.segments * 2)
          entry.upstream.delete(entry.upstream.keys().next().value);
        entry.bytes += body.length;
      }
      entry.failures = 0;
    } catch {
      entry.chunklistUrl = null;
      entry.failures++;
      if (entry.failures >= 3) {
        stop(entry.cameraId, entry.token);
        return;
      }
    } finally {
      if (!entry.stopping) {
        entry.timer = setTimeout(() => {
          entry.polling = poll(entry);
        }, limits.pollMs);
        entry.timer.unref?.();
      }
    }
  };
  const ensure = async (cameraId, url, leaseId = 'legacy') => {
    if (closed) throw new Error('HLS service closed');
    sameOriginHlsUrl(url, url);
    let entry = active.get(cameraId);
    if (entry && entry.url !== url) {
      stop(cameraId);
      entry = null;
    }
    if (entry) {
      touch(entry, leaseId, true);
      return entry;
    }
    // Reserve synchronously, before any await: concurrent creation is singleflight.
    if (active.size >= limits.sessions)
      throw new Error('HLS session capacity reached');
    entry = {
      cameraId,
      url,
      token: newHlsToken(),
      controller: new AbortController(),
      segments: new Map(),
      bytes: 0,
      stopping: false,
      failures: 0,
      nextSeq: 0,
      upstream: new Map(),
      leases: new Map(),
      upstreamNewest: -1,
      pendingDiscontinuity: false,
      discontinuitiesRemoved: 0,
    };
    active.set(cameraId, entry);
    touch(entry, leaseId, true);
    entry.polling = poll(entry);
    return entry;
  };
  const waitReady = async (entry, signal) => {
    const until = Date.now() + limits.readyMs;
    while (!entry.stopping && !signal?.aborted && Date.now() < until) {
      if (entry.segments.size >= 2) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const buildPlaylist = async (entry, cameraId, leaseId = 'legacy') => {
    if (entry.stopping || entry.segments.size < 2) return null;
    touch(entry, leaseId);
    const segments = [...entry.segments.values()].sort((a, b) => a.seq - b.seq);
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((s) => s.duration)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${segments[0].seq}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${entry.discontinuitiesRemoved}`,
    ];
    let previous;
    for (const segment of segments) {
      if (
        segment.discontinuity ||
        (previous !== undefined && segment.seq !== previous + 1)
      )
        lines.push('#EXT-X-DISCONTINUITY');
      lines.push(
        `#EXTINF:${segment.duration.toFixed(3)},`,
        `/api/cctv/media/${encodeURIComponent(cameraId)}/seg_${segment.seq}.ts?session=${entry.token}&lease=${encodeURIComponent(leaseId)}`,
      );
      previous = segment.seq;
    }
    return lines.join('\n') + '\n';
  };
  const getSegment = (cameraId, token, seq, leaseId = 'legacy') => {
    const entry = active.get(cameraId);
    if (!entry || entry.token !== token || !entry.leases.has(leaseId))
      return null;
    const body = entry.segments.get(seq)?.body;
    if (body) touch(entry, leaseId);
    return body || null;
  };
  const shutdown = async () => {
    closed = true;
    const entries = [...active.values()];
    for (const entry of entries) stop(entry.cameraId);
    await Promise.allSettled(entries.map((entry) => entry.polling));
  };
  return {
    ensure,
    waitReady,
    buildPlaylist,
    getSegment,
    stop,
    release,
    shutdown,
    stats: () => ({
      sessions: active.size,
      bytes: [...active.values()].reduce((total, e) => total + e.bytes, 0),
    }),
  };
}

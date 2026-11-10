import { Readable } from 'node:stream';
import { hashSeed, escapeXml, pinnedCameraUrl } from './normalize.js';
import {
  A22_IMAGE_ORIGIN,
  CALGARY_IMAGE_ORIGIN,
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_FRAME_MAX_BODY_BYTES,
  CCTV_MEDIA_FETCH_TIMEOUT_MS,
  CCTV_MEDIA_IDLE_TIMEOUT_MS,
  CCTV_MEDIA_MAX_BODY_BYTES,
  HK_IMAGE_ORIGIN,
  KING_COUNTY_IMAGE_ORIGIN,
  MLIT_RIVER_IMAGE_ORIGIN,
  TRIPCHECK_IMAGE_ORIGIN,
  NSW_IMAGE_ORIGIN,
  NSW_IMAGE_USER_AGENT,
  OTTAWA_IMAGE_ORIGIN,
  TALLINN_IMAGE_ORIGIN,
  TARKTEE_IMAGE_ORIGIN,
  ICELAND_IMAGE_ORIGIN,
  TAIWAN_HIGHWAY_IMAGE_ORIGINS,
  TFL_IMAGE_ORIGIN,
  WARENDORF_IMAGE_ORIGINS,
  WSDOT_IMAGE_ORIGIN,
} from './constants.js';
/**
 * Generate a synthetic SVG billboard image for a CCTV camera placeholder.
 *
 * Produces a 960x540 SVG with a deterministic gradient (hue derived from
 * camera ID hash), scanline overlay, HUD-style grid, and text labels
 * showing camera name, city, ID, status, and current timestamp. Used
 * when no upstream image or Street View fallback is available.
 *
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
 * Coerce a fetch() response body to a Node.js Readable stream.
 *
 * Handles both Node-native streams (.pipe) and web ReadableStreams (.getReader).
 *
 * @param {ReadableStream|NodeJS.ReadableStream|null} body
 * @returns {import('stream').Readable|null}
 */
function toReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === 'function') return body;
  if (typeof body.getReader === 'function') {
    return Readable.fromWeb(body);
  }
  return null;
}

/**
 * Split a Content-Type value into its lower-case essence and parameters.
 *
 * @param {string|null|undefined} value
 * @returns {{essence:string,params:Map<string,string>}|null} Null when the
 *   value is missing or is not a `type/subtype` media type.
 */
function parseMediaType(value) {
  const [head, ...rest] = String(value ?? '').split(';');
  const essence = head.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(essence)) return null;
  const params = new Map();
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    let paramValue = part.slice(eq + 1).trim();
    if (/^".*"$/.test(paramValue)) paramValue = paramValue.slice(1, -1);
    if (name && !params.has(name)) params.set(name, paramValue);
  }
  return { essence, params };
}

/** Still-image types a camera frame may be served as. */
const CCTV_RASTER_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/**
 * The canonical type of a raster camera frame, or null for any other type.
 *
 * @param {string|null|undefined} contentType
 * @returns {string|null}
 */
export function cctvRasterImageType(contentType) {
  const essence = parseMediaType(contentType)?.essence;
  return CCTV_RASTER_IMAGE_TYPES.has(essence) ? essence : null;
}

/**
 * The type to relay a live feed as, or null when the upstream type does not
 * match the feed kind. MJPEG keeps its part boundary, without which the body
 * cannot be split into frames.
 *
 * @param {string} feedType - Normalized feed type (mp4, webm or mjpeg).
 * @param {string|null|undefined} contentType
 * @returns {string|null}
 */
export function cctvLiveMediaType(feedType, contentType) {
  const parsed = parseMediaType(contentType);
  if (!parsed) return null;
  if (feedType === 'mp4' || feedType === 'webm')
    return parsed.essence === `video/${feedType}` ? parsed.essence : null;
  if (feedType !== 'mjpeg' || parsed.essence !== 'multipart/x-mixed-replace')
    return null;
  const boundary = parsed.params.get('boundary') || '';
  if (!/^[0-9A-Za-z'()+_,./:=? -]{0,69}[0-9A-Za-z'()+_,./:=?-]$/.test(boundary))
    return null;
  return /^[0-9A-Za-z'+_.-]+$/.test(boundary)
    ? `multipart/x-mixed-replace; boundary=${boundary}`
    : `multipart/x-mixed-replace; boundary="${boundary}"`;
}

/**
 * Pipe an upstream fetch Response (image or video) to the client HTTP response.
 *
 * Forwards Content-Type, Content-Length, Content-Range, Accept-Ranges, and
 * Cache-Control headers from the upstream. Falls back to buffered arrayBuffer
 * if the body is not streamable.
 *
 * @param {import('http').ServerResponse} res
 * @param {Response} upstream - fetch() Response object.
 * @param {object} [opts]
 * @param {string} [opts.sourceHeader='upstream'] - Value for X-CCTV-Source header.
 * @param {string} [opts.contentType] - Validated type to send instead of the
 *   upstream's own.
 * @param {number} [opts.idleTimeoutMs=CCTV_MEDIA_IDLE_TIMEOUT_MS] - Silence
 *   allowed between upstream chunks before the stream is released. Injectable
 *   only to keep the deadline unit-testable.
 */
export async function proxyMediaResponse(
  res,
  upstream,
  {
    sourceHeader = 'upstream',
    idleTimeoutMs = CCTV_MEDIA_IDLE_TIMEOUT_MS,
    contentType = upstream.headers.get('content-type') ||
      'application/octet-stream',
  } = {},
) {
  const cacheControl = upstream.headers.get('cache-control') || 'no-store';
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges');
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-CCTV-Source': sourceHeader,
  };
  if (contentLength) headers['Content-Length'] = contentLength;
  if (contentRange) headers['Content-Range'] = contentRange;
  if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;

  // Cheap defense: reject an upstream that DECLARES an oversized fixed body.
  // Live MJPEG/HLS streams are unbounded by design and send no content-length,
  // so they pipe normally (piping streams to the client, never buffering).
  if (
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > CCTV_MEDIA_MAX_BODY_BYTES
  ) {
    res.writeHead(502, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Upstream media exceeds size cap' }));
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return;
  }

  res.writeHead(upstream.status, headers);

  const stream = toReadable(upstream.body);
  if (!stream) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    return;
  }

  // The header deadline only covers the wait for a response line. Past that an
  // upstream can hold the connection open and send nothing at all, and the
  // relay would wait on it for as long as the camera host cared to. The
  // deadline below measures the gap between upstream chunks rather than the
  // life of the stream, so a feed that keeps delivering keeps its connection.
  let idleTimer = null;
  const clearIdleDeadline = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  stream.on('error', () => {
    clearIdleDeadline();
    if (!res.writableEnded) res.end();
  });

  // A live camera feed has no end of its own. When the viewer goes away the
  // upstream connection must go with it, or every abandoned view leaves a
  // stream open against the camera host for as long as that host will hold it.
  let released = false;
  const releaseUpstream = () => {
    if (released) return;
    released = true;
    clearIdleDeadline();
    stream.unpipe(res);
    // Destroying the Node stream cancels the web body it wraps; the direct
    // cancel covers a body that was never wrapped, and rejects harmlessly when
    // the reader is already held.
    stream.destroy();
    try {
      const cancelled = upstream.body?.cancel?.();
      if (typeof cancelled?.catch === 'function') cancelled.catch(() => {});
    } catch {
      /* already closed */
    }
  };
  const armIdleDeadline = () => {
    clearIdleDeadline();
    idleTimer = setTimeout(onIdleDeadline, idleTimeoutMs);
    idleTimer.unref?.();
  };
  const onIdleDeadline = () => {
    // A viewer who cannot keep up pauses the pipe, and no upstream bytes arrive
    // while it is paused. That is a slow client rather than a dead camera, so
    // it gets the deadline again instead of a teardown.
    if (res.writableNeedDrain) {
      armIdleDeadline();
      return;
    }
    releaseUpstream();
    if (!res.writableEnded) res.end();
  };
  res.once('close', () => {
    clearIdleDeadline();
    if (!res.writableEnded) releaseUpstream();
  });
  res.once('error', releaseUpstream);
  stream.once('end', () => {
    clearIdleDeadline();
    released = true;
  });
  armIdleDeadline();
  stream.pipe(res);
  // Attached after the pipe because a data listener resumes the stream, and
  // flowing before the destination is attached would spill chunks nobody
  // forwards. Only bytes from upstream renew the deadline.
  stream.on('data', armIdleDeadline);
}

/**
 * Watch a client response for an early goodbye.
 *
 * Bound BEFORE the upstream request goes out, because most of the waiting
 * happens before any header comes back: a viewer who closes the tab while a
 * slow camera is still thinking would otherwise leave that request running with
 * nobody to receive it.
 *
 * @param {import('http').ServerResponse} res - The client response.
 * @returns {{signal: AbortSignal, closed: boolean}} `signal` cancels the
 *   upstream request; `closed` says the client left before the response ended.
 */
export function watchDownstreamClose(res) {
  const controller = new AbortController();
  const state = {
    signal: controller.signal,
    closed: false,
  };
  const onClose = () => {
    // A response that ended normally also emits close; only an early one counts.
    if (res.writableEnded) return;
    state.closed = true;
    controller.abort();
  };
  res.once?.('close', onClose);
  res.once?.('error', onClose);
  return state;
}

/** Read a snapshot incrementally, retaining at most maxBytes of owned chunks. */
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
  // Every retained chunk is an OWNED copy: a chunk can be a small view over a
  // much larger backing ArrayBuffer, and keeping the view would retain that
  // whole allocation while the byte accounting only counted the view.
  const keep = (chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) return false;
    chunks.push(Buffer.from(chunk));
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
    return Buffer.concat(chunks, total);
  }
  // No async iterator: stream through a reader so the cap still applies while
  // reading. A body that cannot be streamed at all is refused rather than
  // buffered uncapped — the helper's whole contract is the cap.
  const reader =
    typeof upstream.body.getReader === 'function'
      ? upstream.body.getReader()
      : null;
  if (!reader) return null;
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
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

/** Open registered media within a header deadline; leave timely live bodies running. */
export async function fetchCctvMediaUpstream(
  url,
  {
    headers = {},
    fetchImpl = fetch,
    timeoutMs = CCTV_MEDIA_FETCH_TIMEOUT_MS,
    signal: downstream = null,
  } = {},
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  // The client going away cancels the upstream request, not just the response
  // to it.
  const onDownstreamAbort = () => controller.abort();
  if (downstream?.aborted) controller.abort();
  else downstream?.addEventListener?.('abort', onDownstreamAbort);
  try {
    // Redirects stay on the registered origin, as for frames.
    const upstream = await fetchWithinHost(
      url,
      { headers, signal: controller.signal },
      fetchImpl,
    );
    if (!upstream) throw new Error('Media redirect refused');
    return upstream;
  } finally {
    clearTimeout(timeoutId);
    downstream?.removeEventListener?.('abort', onDownstreamAbort);
  }
}

/**
 * Fetch and decode a TxDOT ITS / TransGuide snapshot.
 *
 * TxDOT returns JSON with a base64-encoded JPEG in `snippet`, rather than
 * returning image/jpeg directly.
 */
export async function fetchTxdotSnapshot(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
    maxBytes = CCTV_FRAME_MAX_BODY_BYTES,
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
    parsed.origin !== 'https://its.txdot.gov' ||
    parsed.pathname !== '/its/DistrictIts/GetCctvSnapshotByIcdId'
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
        'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
      },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!upstream.ok) return null;
    const envelope = await readCappedResponseBytes(upstream, maxEnvelopeBytes);
    if (!envelope) return null;
    let payload;
    try {
      payload = JSON.parse(envelope.toString('utf8'));
    } catch {
      return null;
    }
    let snippet =
      typeof payload?.snippet === 'string' ? payload.snippet.trim() : '';
    if (!snippet) return null;
    snippet = snippet.replace(/^data:image\/jpeg;base64,/i, '');
    // Canonical base64 only (4-char groups, padding only at the end):
    // Buffer.from() silently skips junk, which would let a non-image body
    // decode into "something".
    if (
      snippet.length > maxEnvelopeBytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        snippet,
      )
    ) {
      return null;
    }
    const body = Buffer.from(snippet, 'base64');
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

/** Redirect hops the frame path will follow, and only within the same host. */
const MAX_SAME_HOST_REDIRECTS = 2;

/**
 * Directories camera catalogs are pinned to, by host. A redirect on one of
 * these hosts must stay inside the pinned directory too, so a same-origin
 * redirect cannot leave it (another bucket on a shared storage host).
 */
const CCTV_PINNED_PREFIXES_BY_HOST = new Map();
for (const prefix of [
  TFL_IMAGE_ORIGIN,
  TALLINN_IMAGE_ORIGIN,
  TARKTEE_IMAGE_ORIGIN,
  ICELAND_IMAGE_ORIGIN,
  ...WARENDORF_IMAGE_ORIGINS,
  NSW_IMAGE_ORIGIN,
  OTTAWA_IMAGE_ORIGIN,
  CALGARY_IMAGE_ORIGIN,
  HK_IMAGE_ORIGIN,
  KING_COUNTY_IMAGE_ORIGIN,
  WSDOT_IMAGE_ORIGIN,
  A22_IMAGE_ORIGIN,
  TRIPCHECK_IMAGE_ORIGIN,
  MLIT_RIVER_IMAGE_ORIGIN,
  ...TAIWAN_HIGHWAY_IMAGE_ORIGINS,
]) {
  const host = new URL(prefix).hostname;
  CCTV_PINNED_PREFIXES_BY_HOST.set(host, [
    ...(CCTV_PINNED_PREFIXES_BY_HOST.get(host) || []),
    prefix,
  ]);
}

/** Whether a redirect target stays inside its host's pinned directory. */
function withinPinnedPrefix(url) {
  const prefixes = CCTV_PINNED_PREFIXES_BY_HOST.get(url.hostname);
  return !prefixes || prefixes.some((p) => pinnedCameraUrl(url.href, p));
}

/**
 * Fetch a registered frame URL following redirects ONLY within the original
 * origin (scheme, host and port; at most MAX_SAME_HOST_REDIRECTS hops) and,
 * on a pinned camera host, within its pinned directory.
 * Default redirect-following would let an upstream steer a host-pinned
 * request, and its host-specific headers, to any origin, another port, or a
 * plaintext downgrade.
 *
 * @param {string} url
 * @param {object} init - fetch init (headers, signal).
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Response|null>} Final response, or null on an off-host or
 *   over-long redirect chain.
 */
export async function fetchWithinHost(url, init, fetchImpl = fetch) {
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
    if (next.origin !== origin || !withinPinnedPrefix(next)) return null;
    current = next;
  }
  return null;
}

/**
 * Image hosts that only serve frames to browser-identified clients, keyed by
 * exact hostname. Every other upstream sees the proxy's own identifying
 * User-Agent. Keyed on host, not on a URL substring, so a look-alike host or a
 * path that merely mentions the host never inherits the header.
 */
const CCTV_IMAGE_USER_AGENT_BY_HOST = Object.freeze({
  [new URL(NSW_IMAGE_ORIGIN).hostname]: NSW_IMAGE_USER_AGENT,
});

/**
 * User-Agent for one upstream frame request.
 *
 * @param {string} url
 * @returns {string}
 */
export function cctvUpstreamUserAgent(url) {
  try {
    return (
      CCTV_IMAGE_USER_AGENT_BY_HOST[new URL(url).hostname] ||
      'gods-eye-view-cctv-proxy/1.0'
    );
  } catch {
    return 'gods-eye-view-cctv-proxy/1.0';
  }
}

/** Largest single JPEG the MJPEG first-frame reader will buffer. */
export const CCTV_MJPEG_FRAME_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read one bounded JPEG part from an open MJPEG response, then stop the stream.
 *
 * The first part may follow a CRLF preamble, and its delimiter may be written
 * as `--<boundary>` or, when the declared boundary already starts with `--`,
 * as the boundary itself. A part with Content-Length is read to that length;
 * a part without one ends at the next delimiter, so a JPEG end marker inside
 * the image (an EXIF thumbnail) never truncates it. Bytes are copied once
 * into a preallocated buffer and every search resumes where it stopped, so a
 * trickling upstream costs linear time.
 */
async function readFirstMjpegFrame(upstream, maxBytes) {
  const mediaType = cctvLiveMediaType(
    'mjpeg',
    upstream.headers.get('content-type'),
  );
  const boundary = parseMediaType(mediaType)?.params.get('boundary') || '';
  const frameMax = Math.min(maxBytes, CCTV_MJPEG_FRAME_MAX_BYTES);
  if (
    !boundary ||
    !upstream.body ||
    !Number.isSafeInteger(frameMax) ||
    frameMax < 4
  ) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return null;
  }

  const delimiters = [Buffer.from('--' + boundary, 'latin1')];
  if (boundary.startsWith('--') && boundary.length > 2)
    delimiters.push(Buffer.from(boundary, 'latin1'));
  const lineEnd = Buffer.from('\r\n', 'ascii');
  const headerTerminator = Buffer.from('\r\n\r\n', 'ascii');
  const jpegStart = Buffer.from([0xff, 0xd8]);
  const jpegEnd = Buffer.from([0xff, 0xd9]);
  const maxPreambleBytes = 64;
  const maxHeaderBytes = 8 * 1024;
  const maxBufferedBytes =
    maxPreambleBytes +
    delimiters[0].length +
    lineEnd.length +
    maxHeaderBytes +
    headerTerminator.length +
    frameMax +
    lineEnd.length +
    delimiters[0].length;
  const buffer = Buffer.allocUnsafe(maxBufferedBytes);
  let length = 0;
  let reader;
  let headerStart = -1;
  let delimiter = null;
  let headerScanFrom = 0;
  let bodyStart = -1;
  let declaredLength = null;
  let boundaryScanFrom = -1;

  /** Match the opening delimiter after an optional CRLF preamble. */
  function findOpening() {
    let at = 0;
    while (at < length && (buffer[at] === 0x0d || buffer[at] === 0x0a)) at++;
    if (at > maxPreambleBytes) return { failed: true };
    for (const candidate of delimiters) {
      const line = Buffer.concat([candidate, lineEnd]);
      const need = at + line.length;
      if (length < need) {
        const seen = buffer.subarray(at, length);
        if (line.subarray(0, seen.length).equals(seen))
          return { pending: true };
        continue;
      }
      if (buffer.subarray(at, need).equals(line))
        return { start: need, delimiter: candidate };
    }
    return { failed: true };
  }

  /** Parse the part headers; false rejects the stream. */
  function parseHeaders(headerEnd) {
    const headerText = buffer
      .subarray(headerStart, headerEnd)
      .toString('latin1');
    const headers = new Map();
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) return false;
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!name || headers.has(name)) return false;
      headers.set(name, line.slice(colon + 1).trim());
    }
    if (cctvRasterImageType(headers.get('content-type')) !== 'image/jpeg')
      return false;
    const declared = headers.get('content-length');
    if (declared !== undefined) {
      if (!/^\d+$/.test(declared)) return false;
      declaredLength = Number(declared);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < jpegStart.length + jpegEnd.length ||
        declaredLength > frameMax
      )
        return false;
    }
    return true;
  }

  /** A complete JPEG body, or null. */
  function asJpeg(frame) {
    return frame.length >= jpegStart.length + jpegEnd.length &&
      frame.subarray(0, jpegStart.length).equals(jpegStart) &&
      frame.subarray(-jpegEnd.length).equals(jpegEnd)
      ? Buffer.from(frame)
      : null;
  }

  try {
    reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;

      const chunk = Buffer.from(value);
      const room = maxBufferedBytes - length;
      const included = Math.min(room, chunk.length);
      chunk.copy(buffer, length, 0, included);
      length += included;
      const overflow = included < chunk.length;

      if (headerStart < 0) {
        const opening = findOpening();
        if (opening.failed) return null;
        if (opening.pending) {
          if (overflow) return null;
          continue;
        }
        headerStart = opening.start;
        delimiter = opening.delimiter;
        headerScanFrom = headerStart;
      }

      if (bodyStart < 0) {
        const headerEnd = buffer
          .subarray(0, length)
          .indexOf(headerTerminator, headerScanFrom);
        if (headerEnd < 0) {
          if (length - headerStart > maxHeaderBytes || overflow) return null;
          headerScanFrom = Math.max(
            headerStart,
            length - headerTerminator.length + 1,
          );
          continue;
        }
        if (headerEnd - headerStart > maxHeaderBytes) return null;
        if (!parseHeaders(headerEnd)) return null;
        bodyStart = headerEnd + headerTerminator.length;
        boundaryScanFrom = bodyStart;
      }

      const available = length - bodyStart;
      if (available >= jpegStart.length) {
        if (
          !buffer
            .subarray(bodyStart, bodyStart + jpegStart.length)
            .equals(jpegStart)
        )
          return null;
      }
      const nextDelimiter = Buffer.concat([lineEnd, delimiter]);
      const nextPart = buffer
        .subarray(0, length)
        .indexOf(nextDelimiter, boundaryScanFrom);
      if (declaredLength !== null) {
        if (nextPart >= bodyStart && nextPart - bodyStart < declaredLength)
          return null;
        if (available >= declaredLength)
          return asJpeg(buffer.subarray(bodyStart, bodyStart + declaredLength));
      } else if (nextPart >= bodyStart) {
        const frame = buffer.subarray(bodyStart, nextPart);
        return frame.length > frameMax ? null : asJpeg(frame);
      } else if (available > frameMax) {
        return null;
      }
      if (nextPart < 0)
        boundaryScanFrom = Math.max(
          bodyStart,
          length - nextDelimiter.length + 1,
        );
      if (overflow) return null;
    }
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* already closed or aborted */
      }
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }
}
/**
 * Fetch one upstream CCTV image within the frame-refresh budget.
 *
 * A timeout is treated like every other upstream miss so the caller can
 * continue through the Street View and synthetic fallback chain. `fetchImpl`
 * and `timeoutMs` are injectable only to keep the timeout contract unit-testable.
 *
 * @param {string} url - Server-registered upstream image URL.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl=fetch] - Fetch implementation.
 * @param {number} [options.timeoutMs=CCTV_FRAME_FETCH_TIMEOUT_MS] - Abort timeout.
 * @param {number} [options.maxBytes=CCTV_FRAME_MAX_BODY_BYTES] - Snapshot byte cap.
 * @param {boolean} [options.allowMjpeg=false] - Accept a multipart MJPEG
 *   answer and keep its first JPEG. Only sources registered as MJPEG stills
 *   (the Taiwan Highway Bureau feeds) set it; any other host answering
 *   multipart falls through to the next fallback.
 * @returns {Promise<{ok:true,body:Buffer,contentType:string}|null>}
 */
export async function fetchCctvImageFromUpstream(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
    maxBytes = CCTV_FRAME_MAX_BODY_BYTES,
    allowMjpeg = false,
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
    if (!upstream.ok) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* no-op */
      }
      return null;
    }
    const upstreamType = upstream.headers.get('content-type');
    const contentType = cctvRasterImageType(upstreamType);
    if (contentType) {
      const body = await readCappedResponseBytes(upstream, maxBytes);
      if (!body) return null;
      return { ok: true, body, contentType };
    }
    if (!allowMjpeg || !cctvLiveMediaType('mjpeg', upstreamType)) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* no-op */
      }
      return null;
    }
    const body = await readFirstMjpegFrame(upstream, maxBytes);
    if (!body) return null;
    return { ok: true, body, contentType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}

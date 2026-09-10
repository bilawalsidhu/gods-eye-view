import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MEDIA_TYPES = new Set([...IMAGE_TYPES, 'video/mp4', 'video/webm',
  'video/mp2t', 'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'multipart/x-mixed-replace']);

export const FRAME_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 64 * 1024 * 1024;

export function mediaContentType(value, { imageOnly = false } = {}) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return (imageOnly ? IMAGE_TYPES : MEDIA_TYPES).has(type) ? type : null;
}

export async function cancelResponse(response) {
  try { await response.body?.cancel(); } catch { /* Already consumed or aborted. */ }
}

/** Stream with backpressure, an actual byte cap, and cancellation on disconnect. */
export async function pipeMediaResponse(res, upstream, { signal,
  maxBytes = MEDIA_MAX_BYTES, sourceHeader = 'upstream' } = {}) {
  const type = upstream.headers.get('content-type');
  if (!upstream.ok || !mediaContentType(type)
    || Number(upstream.headers.get('content-length')) > maxBytes) {
    await cancelResponse(upstream);
    throw new Error('Unsupported or oversized upstream media');
  }
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-CCTV-Source': sourceHeader };
  for (const name of ['content-range', 'accept-ranges']) {
    if (upstream.headers.has(name)) headers[name] = upstream.headers.get(name);
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) { res.end(); return; }
  let bytes = 0;
  const bound = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > maxBytes) done(new Error('Upstream media exceeds size cap'));
    else done(null, chunk);
  } });
  // pipeline destroys both ends on errors, including client disconnects.
  await pipeline(Readable.fromWeb(upstream.body), bound, res, { signal });
}

/** Requires a streaming fetch Response so the bound precedes allocation. */
export async function readResponseBytesCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponse(response);
    throw new Error('Upstream response too large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Upstream response too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Explicit lifetime includes headers AND the response body. */
export function upstreamLifetime(req, res, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Client disconnected'));
  const timer = setTimeout(() => controller.abort(new Error('Upstream deadline exceeded')), timeoutMs);
  req?.once?.('aborted', abort);
  res?.once?.('close', abort);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      req?.off?.('aborted', abort);
      res?.off?.('close', abort);
    },
  };
}

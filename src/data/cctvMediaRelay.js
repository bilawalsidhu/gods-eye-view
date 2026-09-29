// CCTV media relay — the Node half of `/api/cctv/media/:id` (dev middleware).
//
// Runtime-split by design: everything here needs Node streams (`Readable`,
// `res.pipe`), so the Pages Function cannot import this module — it streams
// `upstream.body` into a web `Response` directly, where the workerd runtime
// already tears the upstream down when the client connection closes. The dev
// middleware owns that lifetime itself, and these are the two guarantees it
// must provide (both ported from upstream):
//
//   1. RELEASE: a live camera feed has no end of its own. When the viewer
//      goes away the upstream connection must go with it, or every abandoned
//      view leaves a stream open against the camera host for as long as that
//      host will hold it.
//   2. IDLE DEADLINE: the header deadline only covers the wait for a response
//      line. Past that an upstream can hold the connection open and send
//      nothing at all. The deadline measures the gap between upstream chunks
//      rather than the life of the stream, so a feed that keeps delivering
//      keeps its connection; a stalled one is torn down.
//
// lives in src/data/ (not vite/proxies/) so the unit runner walks its tests;
// it stays Node-only and is imported by no `functions/` handler.
import { Readable } from 'node:stream';
import { buildMediaPassthrough } from './cctvSources.js';

/**
 * Silence a live body may carry before the relay gives up on it. Twice the
 * header deadline, because a camera that is merely slow between frames is far
 * more common than one that has died mid-stream, and a viewer would rather
 * wait than be dropped.
 * @type {number}
 */
export const CCTV_MEDIA_IDLE_TIMEOUT_MS = 30 * 1000;

/**
 * Coerce a fetch() response body to a Node.js Readable stream.
 *
 * Handles both Node-native streams (.pipe) and web ReadableStreams (.getReader).
 *
 * @param {ReadableStream|import('stream').Readable|null} body Upstream body to
 *   wrap; returned untouched when it is already a Node stream.
 * @returns {import('stream').Readable|null} The pipable stream, or null when
 *   the body is neither shape (callers buffer via arrayBuffer instead).
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
 * Watch a client response for an early goodbye.
 *
 * Bound BEFORE the upstream request goes out, because most of the waiting
 * happens before any header comes back: a viewer who closes the tab while a
 * slow camera is still thinking would otherwise leave that request running
 * with nobody to receive it.
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

/**
 * Pipe an upstream media Response into the Node client response, releasing
 * the upstream when the viewer leaves or the feed stalls.
 *
 * @param {import('http').ServerResponse} res - Client response (headers are
 *   written here from the passthrough result).
 * @param {Response} upstream - fetch() Response object (body unconsumed).
 * @param {object} [opts] - Passthrough options.
 * @param {string} [opts.sourceHeader='upstream'] - Value for X-CCTV-Source header.
 * @param {number} [opts.idleTimeoutMs=CCTV_MEDIA_IDLE_TIMEOUT_MS] - Silence
 *   allowed between upstream chunks before the stream is released. Injectable
 *   only to keep the deadline unit-testable.
 * @returns {Promise<void>} Resolves once the fixed body is flushed, or
 *   immediately for a streamed body (the pipe owns the rest).
 */
export async function proxyMediaResponse(
  res,
  upstream,
  { sourceHeader = 'upstream', idleTimeoutMs = CCTV_MEDIA_IDLE_TIMEOUT_MS } = {},
) {
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
    clearIdleDeadline();
    if (!res.writableEnded) res.end();
  });

  // A live camera feed has no end of its own. When the viewer goes away the
  // upstream connection must go with it, or every abandoned view leaves a
  // stream open against the camera host for as long as that host will hold it.
  let released = false;
  let idleTimer = null;
  const clearIdleDeadline = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
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

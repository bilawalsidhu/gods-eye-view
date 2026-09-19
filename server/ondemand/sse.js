/**
 * Verbatim byte-stream piping from an upstream `fetch()` Response body to a
 * Node `ServerResponse` (or any write/end-alike sink) — used both for the
 * chat SSE stream (contract §4: `event:heartbeat`/`event:message` frames,
 * `data:[DONE]`, `data:[ERROR]:...` must reach the client byte-for-byte, with
 * NO re-framing and NO parse-and-reserialise) and for the raw audio bytes
 * returned by /api/ondemand/tts.
 *
 * This module never inspects or parses the bytes it forwards — that is the
 * entire point: OnDemand's SSE framing is the client's contract to satisfy,
 * not this proxy's.
 */

/**
 * @typedef {{ write: (chunk: Buffer) => unknown, end: () => unknown }} Sink
 *   Minimal shape a Node `http.ServerResponse` already satisfies.
 */

/**
 * Pipe `upstreamBody` (a WHATWG `ReadableStream<Uint8Array>`, e.g.
 * `response.body`) to `sink` verbatim, optionally writing a keepalive
 * comment line on an interval while waiting between upstream chunks.
 * Always calls `sink.end()` exactly once, in a `finally`, so the
 * downstream reader completes instead of hanging even if the upstream
 * stream errors.
 *
 * @param {ReadableStream<Uint8Array>} upstreamBody
 * @param {Sink} sink
 * @param {{
 *   keepaliveMs?: number,
 *   keepaliveComment?: string,
 *   scheduleKeepalive?: (fn: () => void, ms: number) => any,
 *   clearKeepalive?: (handle: any) => void,
 * }} [opts]
 */
export async function pipeBinaryBody(upstreamBody, sink, opts = {}) {
  const { keepaliveMs = 0, keepaliveComment = ':\n\n' } = opts;
  const scheduleKeepalive = opts.scheduleKeepalive || setInterval;
  const clearKeepalive = opts.clearKeepalive || clearInterval;

  let keepaliveHandle;
  if (keepaliveMs > 0) {
    keepaliveHandle = scheduleKeepalive(() => {
      try {
        sink.write(keepaliveComment);
      } catch {
        // Client already gone; the outer read loop's next iteration (or its
        // own error) will end the pipe.
      }
    }, keepaliveMs);
  }

  const reader = upstreamBody.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) sink.write(Buffer.from(value));
    }
  } finally {
    if (keepaliveHandle !== undefined) clearKeepalive(keepaliveHandle);
    try {
      reader.releaseLock();
    } catch {
      // already released (e.g. the stream errored internally)
    }
    try {
      sink.end();
    } catch {
      // client already gone
    }
  }
}

/**
 * Thin wrapper over pipeBinaryBody with the chat-stream keepalive default
 * (a `:\n\n` SSE comment every 15s while idle — contract §4 / task spec).
 * @param {ReadableStream<Uint8Array>} upstreamBody
 * @param {Sink} sink
 * @param {{ keepaliveMs?: number }} [opts]
 */
export function pipeSseBody(upstreamBody, sink, opts = {}) {
  return pipeBinaryBody(upstreamBody, sink, {
    keepaliveMs: 15000,
    keepaliveComment: ':\n\n',
    ...opts,
  });
}

/**
 * Wire `req`/`res` "close" events to abort an in-flight upstream fetch —
 * the single most important correctness detail for SSE proxying: without
 * this, the proxy keeps reading (and OnDemand keeps generating/billing
 * tokens for) an answer nobody is receiving. Returns an `unwire()` function
 * to remove the listeners once the pipe has finished normally.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {AbortController} controller
 */
export function wireAbortOnClose(req, res, controller) {
  const abort = () => {
    try {
      controller.abort();
    } catch {
      // already aborted
    }
  };
  req.on('close', abort);
  res.on('close', abort);
  return () => {
    req.off?.('close', abort);
    res.off?.('close', abort);
  };
}

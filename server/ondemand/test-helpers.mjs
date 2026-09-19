/**
 * Shared test doubles for server/ondemand/*.test.mjs. NOT itself a
 * `*.test.mjs` file, so `node --test server/ondemand/*.test.mjs` (shell-glob
 * expanded) never tries to run it directly — it is only ever imported.
 */

/** A minimal fake `http.IncomingMessage` good enough for every handler here:
 * none of them read the body via async iteration when `body` is already
 * supplied (the Vercel/local-emulator pre-parsed-JSON case), and `on`/`off`
 * are only used by chat.js's close-abort wiring. */
export function makeReq({
  method = 'GET',
  url = '/',
  headers = {},
  body,
} = {}) {
  const listeners = {};
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers))
    lowerHeaders[k.toLowerCase()] = v;
  return {
    method,
    url,
    headers: lowerHeaders,
    body,
    on(event, cb) {
      (listeners[event] ||= []).push(cb);
    },
    off(event, cb) {
      if (listeners[event])
        listeners[event] = listeners[event].filter((f) => f !== cb);
    },
    emit(event) {
      for (const cb of listeners[event] || []) cb();
    },
    async *[Symbol.asyncIterator]() {
      // No chunks: handlers under test always supply req.body directly.
    },
  };
}

/** A minimal fake `http.ServerResponse`. */
export function makeRes() {
  const chunks = [];
  const listeners = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    ended: false,
    _headers: {},
    setHeader(k, v) {
      res._headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return res._headers[k.toLowerCase()];
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) res.write(chunk);
      res.ended = true;
    },
    flushHeaders() {
      res.headersSent = true;
    },
    on(event, cb) {
      (listeners[event] ||= []).push(cb);
    },
    off(event, cb) {
      if (listeners[event])
        listeners[event] = listeners[event].filter((f) => f !== cb);
    },
    emit(event) {
      for (const cb of listeners[event] || []) cb();
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    json() {
      return JSON.parse(res.text());
    },
  };
  return res;
}

/**
 * Monkeypatch globalThis.fetch with a queue of canned Responses (or response
 * factories), recording every call's (url, init) for assertions. Call
 * `.restore()` in a `finally` block to undo the monkeypatch.
 * @param {(Response|((url,init)=>Response|Promise<Response>))[]} responses
 */
export function stubFetchSequence(responses) {
  const calls = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Build a fetch-style Response carrying JSON. */
export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Build a fetch-style Response streaming the given text/byte chunks verbatim. */
export function sseResponse(status, chunks, headers = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

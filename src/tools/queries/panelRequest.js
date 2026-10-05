/**
 * The God's Eye View panel's requests. A panel cannot reach the app's server
 * itself: hosts serve panels from their own sites and may refuse other
 * addresses, such as a server on the user's machine. The panel asks this
 * tool instead, and it requests the path from the app's server. Large
 * responses come back in parts.
 *
 * It is meant for the panel. `visibility: ['app']` asks hosts to keep it
 * from the model, and every call must also carry the key in the panel's page
 * (`services.app.panelKey`), so a client that lists the tool to the model
 * without loading the panel cannot use it. The key is not access control:
 * any MCP client can read the panel's page, key included. What protects
 * sensitive routes is that those the panel never needs are refused to every
 * caller.
 */

import { defineTool, ToolError } from '../catalog.js';
import { PANEL_REQUEST_TOOL } from '../globePanel.js';

/** Bytes of response body per call, before base64. */
export const PANEL_PART_BYTES = 512 * 1024;
const HELD_MS = 2 * 60 * 1000;
const HELD_LIMIT_BYTES = 256 * 1024 * 1024;
/** The largest response the panel may load, read up to this and no more. */
export const PANEL_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
// Routes the panel never loads, matched as the server routes them: without
// regard to case, and with a mounted route also matching when a dot follows
// it (`/mcp.json` reaches `/mcp`). Provider Settings, which only the app's own
// page may use; credential and model endpoints; the MCP server itself; and
// the development server's internal routes.
const REFUSED_PATHS = [
  /^\/api\/(?:setup|realtime|openai)(?:[/.]|$)/i,
  /^\/mcp(?:[/.]|$)/i,
  /^\/(?:@|__)/,
];
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type'];
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
]);
// Already compressed, so gzip would only cost time.
const INCOMPRESSIBLE =
  /^(?:image\/(?!svg)|video\/|audio\/|font\/woff2)|zip|compressed/;
const COMPRESS_MIN_BYTES = 1024;

/**
 * Requests in flight at once for one server's panels. Several panels (one
 * per conversation) share a server, so further requests wait their turn
 * rather than fail; past `PANEL_QUEUED_REQUESTS` waiting, they are refused.
 */
export const PANEL_CONCURRENT_REQUESTS = 6;
export const PANEL_QUEUED_REQUESTS = 256;

/**
 * Each server's panel state: bodies too large for one call, kept for the
 * calls that read the rest, and the requests in flight. Kept per server
 * (its `services.app`), so one server's panel never reads another's.
 */
const panels = new WeakMap();
function panelState(app) {
  if (!panels.has(app))
    panels.set(app, {
      held: new Map(),
      heldBytes: 0,
      inFlight: 0,
      waiting: [],
    });
  return panels.get(app);
}

/** Take a place among the requests in flight, waiting for one if need be. */
async function acquire(state, signal) {
  if (state.inFlight < PANEL_CONCURRENT_REQUESTS) {
    state.inFlight += 1;
    return;
  }
  if (state.waiting.length >= PANEL_QUEUED_REQUESTS)
    throw new ToolError(
      'retry_later',
      'The panel has too many requests waiting',
      {
        retryAfterSeconds: 1,
      },
    );
  await new Promise((resolve, reject) => {
    const waiter = { resolve };
    const abort = () => {
      const index = state.waiting.indexOf(waiter);
      if (index !== -1) state.waiting.splice(index, 1);
      reject(signal.reason);
    };
    waiter.resolve = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
    state.waiting.push(waiter);
  });
}

/** Give up a place, handing it straight to the next waiting request. */
function releaseSlot(state) {
  const next = state.waiting.shift();
  if (next) next.resolve();
  else state.inFlight -= 1;
}

function base64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** Compare a caller's key with the panel's, in time independent of where they differ. */
function isPanelKey(given, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof given !== 'string' || given.length !== expected.length)
    return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1)
    difference |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

async function gzip(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function release(state, id) {
  state.heldBytes -= state.held.get(id).bytes.length;
  state.held.delete(id);
}

/** Drop held responses nobody continued in time. */
function forgetExpired(state, now = Date.now()) {
  for (const [id, entry] of state.held)
    if (entry.expires <= now) release(state, id);
}

/** Hold a response for its later parts, first making room for it. */
function hold(state, id, entry) {
  forgetExpired(state);
  // Oldest first; a response being read is renewed, so it is the newest.
  for (const oldest of state.held.keys()) {
    if (state.heldBytes + entry.bytes.length <= HELD_LIMIT_BYTES) break;
    release(state, oldest);
  }
  state.held.set(id, entry);
  state.heldBytes += entry.bytes.length;
}

/** Read a response body, refusing one larger than the panel may load. */
async function readLimited(answer) {
  const reader = answer.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > PANEL_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new ToolError('unavailable', 'The response is too large to load');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function part(response, bytes, offset) {
  const end = Math.min(bytes.length, offset + PANEL_PART_BYTES);
  return {
    ...response,
    offset,
    body: base64(bytes.subarray(offset, end)),
    ...(end < bytes.length ? { nextOffset: end } : {}),
  };
}

/**
 * The path to request, as the URL parser reads it against the app's
 * address. Anything that leaves the app's server is refused, including
 * paths parsers read as another host: two slashes, or a slash and a
 * backslash. Refused routes are matched decoded too, as servers route.
 */
function checkedPath(path, baseUrl) {
  if (typeof path !== 'string' || !path.startsWith('/'))
    throw new ToolError('invalid_arguments', 'path must start with /');
  const base = new URL(baseUrl);
  let url;
  try {
    url = new URL(path, base);
  } catch {
    throw new ToolError('invalid_arguments', 'path is not a valid path');
  }
  if (url.origin !== base.origin)
    throw new ToolError(
      'invalid_arguments',
      "path must stay on the app's server",
    );
  const { pathname } = url;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ToolError('invalid_arguments', 'path is not a valid path');
  }
  if (
    REFUSED_PATHS.some(
      (pattern) => pattern.test(pathname) || pattern.test(decoded),
    )
  )
    throw new ToolError('invalid_arguments', `${pathname} is not available`);
  return pathname + url.search;
}

export const panelRequest = defineTool({
  name: PANEL_REQUEST_TOOL,
  title: "God's Eye View panel request",
  description:
    "Loads a file or data for the God's Eye View panel from the app's " +
    'server. Only the panel calls this; it does not answer questions.',
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: "The panel's key, from its own page.",
      },
      path: {
        type: 'string',
        description: "A path on the app's server, starting with /.",
      },
      method: { type: 'string', enum: [...METHODS] },
      headers: {
        type: 'object',
        description: 'Request headers; only Accept and Content-Type are sent.',
      },
      body: { type: 'string', description: 'The request body, base64.' },
      id: {
        type: 'string',
        description: 'Continue a response an earlier call returned in parts.',
      },
      offset: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  requires: ['app'],
  ui: { visibility: ['app'] },
  async run(args, { services, signal }) {
    if (!isPanelKey(args.key, services.app.panelKey))
      throw new ToolError(
        'invalid_arguments',
        "Only the God's Eye View panel may make this request",
      );
    const state = panelState(services.app);
    forgetExpired(state);
    if (args.id !== undefined) {
      const entry = state.held.get(args.id);
      if (entry) {
        // Still being read: renew it, and keep it newest.
        state.held.delete(args.id);
        state.held.set(args.id, { ...entry, expires: Date.now() + HELD_MS });
      }
      if (!entry)
        throw new ToolError(
          'invalid_arguments',
          'That response is no longer held; request the path again',
        );
      return {
        summary: `Part of ${entry.path}`,
        data: part(entry.response, entry.bytes, args.offset ?? 0),
      };
    }
    const path = checkedPath(args.path, services.app.baseUrl);
    const method = args.method ?? 'GET';
    if (!METHODS.has(method))
      throw new ToolError('invalid_arguments', `Unsupported method ${method}`);
    const headers = {};
    for (const [name, value] of Object.entries(args.headers ?? {})) {
      if (FORWARDED_REQUEST_HEADERS.includes(name.toLowerCase()))
        headers[name] = String(value);
    }
    signal?.throwIfAborted();
    await acquire(state, signal);
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let answer;
    let bytes;
    try {
      answer = await services.app.fetch(path, {
        method,
        headers,
        ...(args.body !== undefined && method === 'POST'
          ? { body: fromBase64(args.body) }
          : {}),
        // A redirect could lead off the app's server; the panel gets it as is.
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      bytes = await readLimited(answer);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ToolError) throw error;
      throw new ToolError('unavailable', "The app's server did not answer");
    } finally {
      releaseSlot(state);
    }
    const type = answer.headers.get('content-type') || '';
    let encoding = 'identity';
    if (bytes.length >= COMPRESS_MIN_BYTES && !INCOMPRESSIBLE.test(type)) {
      bytes = await gzip(bytes);
      encoding = 'gzip';
    }
    const responseHeaders = {};
    answer.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
    });
    const response = {
      status: answer.status,
      statusText: answer.statusText,
      headers: responseHeaders,
      encoding,
      totalBytes: bytes.length,
    };
    if (bytes.length > PANEL_PART_BYTES) {
      response.id = crypto.randomUUID();
      hold(state, response.id, {
        path,
        response,
        bytes,
        expires: Date.now() + HELD_MS,
      });
    }
    return {
      summary: `${answer.status} ${method} ${path}`,
      data: part(response, bytes, 0),
    };
  },
});

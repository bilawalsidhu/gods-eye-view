/**
 * The God's Eye View panel's requests. A panel cannot reach the app's server
 * itself: hosts serve panels from their own sites and may refuse other
 * addresses, such as a server on the user's machine. The panel asks this
 * tool instead, which only an app may call, and it requests the path from
 * the app's server. Large responses come back in parts.
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
// Provider Settings write the app's keys; only the app's own page may.
const REFUSED_PATHS = [/^\/api\/setup(?:\/|$)/];
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

// Bodies too large for one call, kept for the calls that read the rest.
const held = new Map();
let heldBytes = 0;

function base64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function gzip(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function release(id) {
  heldBytes -= held.get(id).bytes.length;
  held.delete(id);
}

/** Drop held responses nobody continued in time. */
function forgetExpired(now = Date.now()) {
  for (const [id, entry] of held) if (entry.expires <= now) release(id);
}

/** Hold a response for its later parts, first making room for it. */
function hold(id, entry) {
  forgetExpired();
  // Oldest first; a response being read is renewed, so it is the newest.
  for (const oldest of held.keys()) {
    if (heldBytes + entry.bytes.length <= HELD_LIMIT_BYTES) break;
    release(oldest);
  }
  held.set(id, entry);
  heldBytes += entry.bytes.length;
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
    forgetExpired();
    if (args.id !== undefined) {
      const entry = held.get(args.id);
      if (entry) {
        // Still being read: renew it, and keep it newest.
        held.delete(args.id);
        held.set(args.id, { ...entry, expires: Date.now() + HELD_MS });
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
      hold(response.id, {
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

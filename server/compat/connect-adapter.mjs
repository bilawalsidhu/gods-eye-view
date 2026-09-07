import { PassThrough, Readable, Writable } from 'node:stream';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function abortError() {
  const error = new Error('Compatibility request aborted');
  error.name = 'AbortError';
  return error;
}

function requestBody(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function relativeUrl(url, mountPath) {
  const parsed = new URL(url, 'http://compatibility.local');
  const pathname = parsed.pathname.slice(mountPath.length) || '/';
  return `${pathname.startsWith('/') ? pathname : `/${pathname}`}${parsed.search}`;
}

class CaptureResponse extends Writable {
  constructor(maxBytes) {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.chunks = [];
    this.headers = new Map();
  }

  setHeader(name, value) {
    if (this.headersSent) throw new Error('Headers already sent');
    this.headers.set(String(name).toLowerCase(), value);
    return this;
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  removeHeader(name) {
    this.headers.delete(String(name).toLowerCase());
  }

  writeHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
    this.statusCode = Number(statusCode);
    const headers = typeof statusMessageOrHeaders === 'object'
      ? statusMessageOrHeaders
      : maybeHeaders;
    for (const [name, value] of Object.entries(headers || {})) {
      this.headers.set(name.toLowerCase(), value);
    }
    this.headersSent = true;
    return this;
  }

  _write(chunk, encoding, callback) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytes += value.byteLength;
    if (this.bytes > this.maxBytes) {
      const error = new Error('Compatibility response exceeds configured limit');
      error.code = 'RESPONSE_TOO_LARGE';
      callback(error);
      return;
    }
    this.headersSent = true;
    this.chunks.push(value);
    callback();
  }

  _final(callback) {
    this.headersSent = true;
    callback();
  }

  result() {
    const headers = {};
    for (const [name, value] of this.headers) {
      if (HOP_BY_HOP_HEADERS.has(name) || name === 'set-cookie') continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return {
      status: this.statusCode,
      headers,
      body: Buffer.concat(this.chunks),
    };
  }
}

class StreamingResponse extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.headers = new Map();
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  setHeader(name, value) {
    if (this.headersSent) throw new Error('Headers already sent');
    this.headers.set(String(name).toLowerCase(), value);
    return this;
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  removeHeader(name) {
    this.headers.delete(String(name).toLowerCase());
  }

  writeHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
    this.statusCode = Number(statusCode);
    const headers = typeof statusMessageOrHeaders === 'object'
      ? statusMessageOrHeaders
      : maybeHeaders;
    for (const [name, value] of Object.entries(headers || {})) {
      this.headers.set(name.toLowerCase(), value);
    }
    this.headersSent = true;
    this.resolveReady();
    return this;
  }

  _final(callback) {
    this.headersSent = true;
    this.resolveReady();
    callback();
  }

  result() {
    const headers = {};
    for (const [name, value] of this.headers) {
      if (HOP_BY_HOP_HEADERS.has(name) || name === 'set-cookie') continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return {
      status: this.statusCode,
      headers,
      body: this,
    };
  }
}

function collectMiddleware(plugins) {
  const routes = [];
  const middlewares = {
    use(mountPath, handler) {
      if (typeof mountPath !== 'string' || typeof handler !== 'function') {
        throw new TypeError('Retained middleware must register a path and handler');
      }
      routes.push({ mountPath, handler });
    },
  };
  for (const plugin of plugins) {
    plugin.configureServer?.({ middlewares, httpServer: null });
  }
  return routes.sort((left, right) => right.mountPath.length - left.mountPath.length);
}

function findRoute(routes, request) {
  const pathname = new URL(request.url, 'http://compatibility.local').pathname;
  return routes.find(({ mountPath }) => (
    pathname === mountPath || pathname.startsWith(`${mountPath}/`)
  ));
}

export function createConnectCompatibilityBridge({
  plugins,
  responseLimitBytes,
  contractIds,
}) {
  const routes = collectMiddleware(plugins);
  const supportedContracts = new Set(contractIds);

  return {
    async handle(request) {
      if (!supportedContracts.has(request.contractId)) {
        throw new Error(`Unsupported compatibility contract: ${request.contractId}`);
      }
      if (request.signal.aborted) throw abortError();

      const route = findRoute(routes, request);
      if (!route) throw new Error(`No retained middleware for ${request.contractId}`);

      const incoming = Readable.from(requestBody(request.body));
      incoming.method = request.method;
      incoming.url = relativeUrl(request.url, route.mountPath);
      incoming.originalUrl = request.url;
      incoming.headers = { ...request.headers };
      incoming.socket = { remoteAddress: request.remoteAddress || 'local' };
      incoming.signal = request.signal;
      incoming.on('error', () => {});

      const streamMedia = request.contractId === 'cctv'
        && new URL(request.url, 'http://compatibility.local').pathname.startsWith('/api/cctv/media/');
      const response = streamMedia
        ? new StreamingResponse()
        : new CaptureResponse(responseLimitBytes);
      const completed = new Promise((resolve, reject) => {
        response.once('finish', resolve);
        response.once('error', reject);
      });
      completed.catch(() => {});
      let rejectAbort;
      const aborted = new Promise((_, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => {
        const error = abortError();
        incoming.destroy(abortError());
        response.destroy(error);
        rejectAbort(error);
      };
      request.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const handling = Promise.resolve(route.handler(incoming, response));
        await Promise.race([handling, aborted]);
        if (streamMedia) {
          await Promise.race([response.ready, aborted]);
          return response.result();
        }
        await completed;
        return response.result();
      } catch (error) {
        if (!response.destroyed) response.destroy();
        throw error;
      } finally {
        request.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

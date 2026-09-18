/**
 * server/tools/_invoke.js — run an existing provider middleware
 * (server/providers/** Vite/Connect plugin) IN-PROCESS so a tool handler can
 * reuse the exact proxy logic (caches, breakers, fallbacks, status headers)
 * that the browser layers already exercise — no HTTP loopback, no second
 * function, no duplicated upstream code.
 *
 *   const invoke = createPluginInvoker(() => celestrakProxy());
 *   const { status, headers, text, json } = await invoke('/api/celestrak/stations');
 *
 * The plugin instance is created once per module (module-level singleton) so
 * its in-memory caches persist for the life of the warm function instance.
 */
export function createPluginInvoker(pluginFactory) {
  let mounts = null;
  function ensure() {
    if (mounts) return mounts;
    mounts = [];
    const plugin = pluginFactory();
    const fakeServer = {
      middlewares: {
        use(route, handler) {
          if (typeof route === 'function') mounts.push(['/', route]);
          else mounts.push([route, handler]);
        },
      },
      httpServer: undefined,
      config: {},
      restart: () => Promise.resolve(),
    };
    if (typeof plugin.configureServer === 'function') {
      plugin.configureServer(fakeServer);
    }
    return mounts;
  }

  /**
   * @param {string} pathWithQuery e.g. '/api/opensky?lat=30&lon=-97'
   * @param {{ method?: string, headers?: Record<string,string>, signal?: AbortSignal }} [init]
   */
  return async function invoke(pathWithQuery, init = {}) {
    const url = new URL(pathWithQuery, 'http://localhost');
    const mount = ensure().find(
      ([route]) =>
        url.pathname === route || url.pathname.startsWith(route + '/'),
    );
    if (!mount) {
      return { status: 404, headers: {}, text: '', json: null };
    }
    const [route, handler] = mount;
    const rest = url.pathname.slice(route.length) || '/';
    const req = {
      method: init.method || 'GET',
      url: rest + url.search,
      headers: { host: 'localhost', ...(init.headers || {}) },
      on(event, fn) {
        if (event === 'close' && init.signal) {
          init.signal.addEventListener('abort', fn, { once: true });
        }
      },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {},
    };
    const chunks = [];
    const headers = {};
    let done;
    const finished = new Promise((resolve) => {
      done = resolve;
    });
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) {
        headers[String(k).toLowerCase()] = v;
      },
      getHeader(k) {
        return headers[String(k).toLowerCase()];
      },
      writeHead(status, hdrs) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(hdrs || {}))
          headers[String(k).toLowerCase()] = v;
        this.headersSent = true;
        return this;
      },
      write(chunk) {
        if (chunk != null) chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk != null) chunks.push(Buffer.from(chunk));
        this.headersSent = true;
        done();
      },
      on() {},
      once() {},
    };
    await handler(req, res, () => {
      res.statusCode = 404;
      res.end('');
    });
    await finished;
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.statusCode, headers, text, json };
  };
}

/** Provider status object from proxy response headers (server/providers/common/upstream.js statusHeaders). */
export function providerFromHeaders(headers) {
  const h = (k) => headers?.[k] ?? null;
  if (!h('x-provider-status')) return null;
  const ageSec = Number(h('x-provider-age-sec'));
  const count = Number(h('x-provider-count'));
  return {
    status: h('x-provider-status'),
    source: h('x-provider-source'),
    fetchedAt: h('x-provider-fetched-at'),
    ageSec: Number.isFinite(ageSec) ? ageSec : null,
    error: h('x-provider-error'),
    count: Number.isFinite(count) ? count : null,
  };
}

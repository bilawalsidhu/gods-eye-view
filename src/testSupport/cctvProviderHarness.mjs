import { cctvProxy } from '../../server/providers/cctv.js';

/** Collects what a handler wrote, the way a Node ServerResponse would. */
export function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = { ...res.headers, ...headers };
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

export function mountCctvProvider(t, { cameras, fetch }) {
  const saved = {};
  for (const name of [
    'CCTV_SOURCES_JSON',
    'CCTV_SOURCES_FILE',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'GEV_RATELIMIT_GOOGLE_PER_MIN',
  ])
    saved[name] = process.env[name];

  const nativeFetch = globalThis.fetch;
  const closers = [];
  t.after(() => {
    for (const close of closers) close();
    globalThis.fetch = nativeFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  process.env.CCTV_SOURCES_JSON = JSON.stringify(cameras);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  // No Street View key: a /frame miss lands on the synthetic billboard.
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  // The default Google budget, whatever the shell sets.
  delete process.env.GEV_RATELIMIT_GOOGLE_PER_MIN;
  // The HLS puller binds fetch when cctvProxy() creates it, so mock first.
  globalThis.fetch = fetch;
  let handler;
  cctvProxy().configureServer({
    httpServer: { on: (_event, fn) => closers.push(fn) },
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  if (!handler) throw new Error('the CCTV provider must mount a middleware');

  const call = async (path, headers = {}, method = 'GET', remoteAddress) => {
    const { res, done } = recordingResponse();
    await handler(
      { url: path, headers, method, socket: { remoteAddress }, on() {} },
      res,
    );
    await done;
    return res;
  };
  const health = async (id) => {
    const res = await call('/health');
    return JSON.parse(res.body).cameras.find((entry) => entry.id === id);
  };
  return { call, health, handler };
}

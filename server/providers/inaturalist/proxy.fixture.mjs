import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { inaturalistProxy } from './observations.js';

export const NOW = Date.parse('2026-11-04T18:05:00Z');

/** Mount the proxy over synthetic HTTP objects, without opening a socket. */
export function installInatProxy(
  defaultUrl,
  options = {},
  hook = 'configureServer',
) {
  let handler;
  const plugin = inaturalistProxy({
    now: () => NOW,
    cacheDir: null,
    queueOptions: { intervalMs: 0, windowMs: 0 },
    warn() {},
    ...options,
  });
  assert.equal(plugin.name, 'inaturalist');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(mount, callback) {
        assert.equal(mount, '/api/inaturalist');
        handler = callback;
      },
    },
  });
  return async (
    url = defaultUrl,
    { method = 'GET', peer = 'local', headers = {}, signal } = {},
  ) => {
    const res = Object.assign(new EventEmitter(), {
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        Object.assign(this.headers, headers);
      },
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(value) {
        this.status ??= this.statusCode;
        this.body = JSON.parse(value);
      },
    });
    const abort = () => {
      res.destroyed = true;
      res.emit('close');
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await handler(
        Object.assign(new EventEmitter(), {
          url,
          method,
          headers,
          socket: { remoteAddress: peer },
        }),
        res,
      );
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    return res;
  };
}

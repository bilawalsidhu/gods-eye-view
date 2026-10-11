import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGoogleTokenSource } from '../../src/maps/googleTokens.js';
import { googleTokenUnavailablePlugin } from './google-token-unavailable.js';

async function withServer({ beforeFallback } = {}, check) {
  const middlewares = [];
  const app = {
    middlewares: {
      use: (handler) => middlewares.push(handler),
    },
  };
  if (beforeFallback) app.middlewares.use(beforeFallback);
  googleTokenUnavailablePlugin().configureServer(app);
  app.middlewares.use((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown API route' }));
  });

  const server = createServer((req, res) => {
    let index = 0;
    const next = () => middlewares[index++]?.(req, res, next);
    next();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const url = 'http://127.0.0.1:' + address.port;
  try {
    await check(url);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('keyless GET and HEAD return uncached 204 instead of 404', async () => {
  await withServer({}, async (url) => {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(url + '/api/google/tiles-token?probe=1', {
        method,
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), '');
    }
  });
});

test('the existing client treats unavailable tokens as null', async () => {
  await withServer({}, async (url) => {
    const source = createGoogleTokenSource({
      fetchImpl: (path, options) => fetch(new URL(path, url), options),
    });
    assert.equal(await source.token(), null);
  });
});

test('unrelated API paths and unsupported methods remain 404', async () => {
  await withServer({}, async (url) => {
    for (const [path, method] of [
      ['/api/google/tiles-token/extra', 'GET'],
      ['/api/not-a-token', 'GET'],
      ['/api/google/tiles-token', 'POST'],
    ]) {
      const response = await fetch(new URL(path, url), { method });
      assert.equal(response.status, 404);
    }
  });
});

test('a real token provider registered first still wins', async () => {
  await withServer(
    {
      beforeFallback: (req, res, next) => {
        if (req.url !== '/api/google/tiles-token') return next();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            accessToken: 'server-token',
            expiresAt: 10000000000000,
          }),
        );
      },
    },
    async (url) => {
      const response = await fetch(url + '/api/google/tiles-token');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).accessToken, 'server-token');
    },
  );
});

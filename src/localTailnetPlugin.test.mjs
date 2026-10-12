import test from 'node:test';
import assert from 'node:assert/strict';
import { privateTailnetPlugin } from '../server/standalone/tailnet-access.js';

test('Serve gate is an explicit opt-in and incomplete configuration cannot silently expose the app', () => {
  assert.equal(privateTailnetPlugin(), null);
  assert.throws(() =>
    privateTailnetPlugin({ origin: 'https://desktop.example.ts.net' }),
  );
  assert.throws(() =>
    privateTailnetPlugin({ ownerLogin: 'owner@example.invalid' }),
  );
});

test('only validated owner requests pass; setup stays local; a spoofed identity header grants nothing', () => {
  let middleware;
  const plugin = privateTailnetPlugin({
    origin: 'https://desktop.example.ts.net',
    ownerLogin: 'owner@example.invalid',
  });
  plugin.configureServer({
    middlewares: {
      use(fn) {
        middleware = fn;
      },
    },
  });
  const request = (url, headers, remoteAddress = '127.0.0.1') => {
    let passed = false,
      status;
    middleware(
      { url, method: 'GET', headers, socket: { remoteAddress } },
      {
        writeHead(code) {
          status = code;
        },
        end() {},
      },
      () => {
        passed = true;
      },
    );
    return { passed, status };
  };
  const headers = {
    host: 'desktop.example.ts.net',
    'tailscale-user-login': 'owner@example.invalid',
    'x-forwarded-proto': 'https',
    origin: 'https://desktop.example.ts.net',
    'sec-fetch-site': 'same-origin',
  };
  assert.equal(request('/', headers).passed, true);
  assert.equal(request('/api/setup/status', headers).status, 403);
  assert.equal(
    request('/', {
      ...headers,
      'tailscale-user-login': 'other@example.invalid',
    }).status,
    403,
  );
  assert.equal(request('/', headers, '192.0.2.1').status, 403);
  assert.equal(request('/', { host: 'localhost' }).passed, true);
  assert.equal(
    request('/', {
      host: 'localhost',
      'tailscale-user-login': 'owner@example.invalid',
    }).status,
    403,
  );
});

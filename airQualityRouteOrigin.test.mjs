import test from 'node:test';
import assert from 'node:assert/strict';
import { openAqProxy } from './server/providers/openAq.js';

test('cross-site request to OpenAQ is refused before key lookup', async () => {
  let keyReads = 0,
    fetches = 0;
  let handler;
  openAqProxy({
    getKey: () => {
      keyReads++;
      return 'k';
    },
    fetchImpl: async () => {
      fetches++;
      return new Response('{}', { status: 503 });
    },
  }).configureServer({
    middlewares: {
      use(_p, fn) {
        handler = fn;
      },
    },
  });
  let status;
  await handler(
    {
      method: 'GET',
      url: '/',
      headers: {
        host: 'localhost:5173',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    },
    {
      destroyed: false,
      once() {},
      removeListener() {},
      setHeader() {},
      writeHead(s) {
        status = s;
      },
      end() {
        status ??= this.statusCode;
      },
    },
  );
  assert.equal(
    status,
    403,
    `got ${status}, keyReads=${keyReads}, fetches=${fetches}`,
  );
  assert.equal(keyReads, 0);
});

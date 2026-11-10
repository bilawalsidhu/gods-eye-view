import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adsbdbProxy } from './enrichment.js';

// The proxy keeps its disk cache under the working directory.
process.chdir(mkdtempSync(path.join(tmpdir(), 'gev-adsbdb-')));

function install() {
  let handler;
  adsbdbProxy().configureServer({
    middlewares: {
      use(mount, callback) {
        assert.equal(mount, '/api/adsbdb');
        handler = callback;
      },
    },
  });
  return async (url) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(value) {
        this.body = JSON.parse(value);
      },
    };
    await handler({ url, method: 'GET', headers: {} }, res);
    return res;
  };
}

function stubFetch(t, respond) {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(String(url));
    return respond(String(url));
  });
  return asked;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('an airline code resolves to the airlines holding it, once per code', async (t) => {
  const asked = stubFetch(t, () =>
    json(200, {
      response: [
        {
          name: 'Example Airline',
          icao: 'ZXY',
          iata: 'ZX',
          country: 'Nowhere',
          callsign: 'EXAMPLE',
        },
        { name: 'No ICAO', icao: '', iata: 'ZX' },
      ],
    }),
  );
  const request = install();
  for (const url of ['/airline/zx', '/airline/ZX']) {
    const res = await request(url);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      found: true,
      airlines: [{ name: 'Example Airline', icao: 'ZXY', iata: 'ZX' }],
    });
  }
  assert.deepEqual(asked, ['https://api.adsbdb.com/v0/airline/ZX']);
});

test('an unknown airline code is a cached miss', async (t) => {
  const asked = stubFetch(t, () => json(404, { response: 'unknown airline' }));
  const request = install();
  assert.deepEqual((await request('/airline/Q9')).body, { found: false });
  assert.deepEqual((await request('/airline/Q9')).body, { found: false });
  assert.equal(asked.length, 1);
});

test('only airline designators reach upstream', async (t) => {
  const asked = stubFetch(t, () => json(200, { response: [] }));
  const request = install();
  for (const code of ['12', 'A', 'ABCD', 'AB1', '%2E%2E', 'A%2FB']) {
    assert.equal((await request(`/airline/${code}`)).status, 400, code);
  }
  assert.deepEqual(asked, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebReceiversProxyMiddleware,
  mergeWebReceivers,
  normalizeKiwiSdrRows,
  normalizeReceiverbookSites,
  publicWebReceiverUrl,
  webReceiverId,
} from '../../server/providers/web-receivers.js';

const RECEIVERBOOK_HTML = `<html><body><script>
var receivers = [{"label":"SDRPT","location":{"coordinates":[-8.7457,39.2939],"type":"Point"},"receivers":[{"label":"SDRPT3 - WebSDR Airband","version":"1.2.123","url":"http://sdrpt.dynip.sapo.pt:8074/","type":"OpenWebRX"},{"label":"SDRPT2 - WebSDR VHF/UHF/CB/10m","version":"1.2.123","url":"http://sdrpt.dynip.sapo.pt:8073/","type":"OpenWebRX"}]},
{"label":"Twente","location":{"coordinates":[6.875,52.2292],"type":"Point"},"receivers":[{"label":"WebSDR at the University of Twente 0-29 MHz","url":"http://websdr.ewi.utwente.nl:8901/","type":"WebSDR"}]},
{"label":"Arvika","location":{"coordinates":[12.526,59.546],"type":"Point"},"receivers":[{"label":"SA4BNA 0-32 MHZ SDR 1, Arvika","url":"http://sa4bna.hopto.org:8073","type":"KiwiSDR"}]},
{"label":"Private","location":{"coordinates":[13.4,52.5],"type":"Point"},"receivers":[{"label":"Lab box","url":"http://192.168.1.20:8073/","type":"KiwiSDR"},{"label":"Local","url":"http://sdr.local:8073/","type":"OpenWebRX"}]},
{"label":"Null island","location":{"coordinates":[0,0],"type":"Point"},"receivers":[{"label":"Nowhere","url":"http://nowhere.example.org:8073/","type":"OpenWebRX"}]},
{"label":"Odd \\"quoted\\" [site]","location":{"coordinates":[2.35,48.85],"type":"Point"},"receivers":[{"label":"Paris 2m","url":"https://paris.example.org/rx/","type":"OpenWebRX"}]}
];
</script></body></html>`;

const KIWI_JS = `// KiwiSDR.com receiver list for dyatlov map maker
var kiwisdr_com =
[
	{"status":"active","offline":"no","name":"SA4BNA 0-32 MHZ SDR 1, Arvika","bands":"0-30000000","users":"3","users_max":"8","gps":"(59.546000, 12.526000)","loc":"Glava , Arvika","antenna":"100 mtr beverage","url":"http://sa4bna.hopto.org:8073"},
	{"status":"active","offline":"yes","name":"Sleeping Kiwi","bands":"0-30000000","users":"0","users_max":"4","gps":"(51.5, -0.1)","loc":"London","antenna":"loop","url":"http://sleepy.example.net:8073"},
	{"status":"active","offline":"no","name":"No GPS Kiwi","bands":"0-30000000","users":"0","users_max":"4","gps":"","loc":"?","antenna":"","url":"http://nogps.example.net:8073"},
]
;`;

function fakeResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

function createFetch(map) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const entry = map[url];
      if (!entry) throw new Error(`unexpected fetch ${url}`);
      return entry();
    },
  };
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeReq(method = 'GET', url = '/catalog') {
  return { method, url };
}

function fakeRes() {
  const res = { status: 0, headers: null, body: '' };
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.end = (body = '') => {
    res.body = body;
    res.ended = true;
  };
  res.json = () => JSON.parse(res.body);
  return res;
}

test('publicWebReceiverUrl keeps public http(s) receivers and drops private/local targets', () => {
  assert.equal(
    publicWebReceiverUrl('http://sa4bna.hopto.org:8073'),
    'http://sa4bna.hopto.org:8073/',
  );
  assert.equal(
    publicWebReceiverUrl('HTTPS://Paris.Example.org/rx?x=1#y'),
    'https://paris.example.org/rx/',
  );
  assert.equal(publicWebReceiverUrl('http://192.168.1.20:8073/'), null);
  assert.equal(publicWebReceiverUrl('http://10.0.0.5/'), null);
  assert.equal(publicWebReceiverUrl('http://sdr.local:8073/'), null);
  assert.equal(publicWebReceiverUrl('http://localhost:8073/'), null);
  assert.equal(publicWebReceiverUrl('http://[::1]:8073/'), null);
  assert.equal(publicWebReceiverUrl('http://user:pw@sdr.example.org/'), null);
  assert.equal(publicWebReceiverUrl('ftp://sdr.example.org/'), null);
  assert.equal(publicWebReceiverUrl('not a url'), null);
  assert.equal(
    webReceiverId('http://sa4bna.hopto.org:8073/'),
    webReceiverId('http://sa4bna.hopto.org:8073'),
  );
  assert.notEqual(
    webReceiverId('http://sa4bna.hopto.org:8073/'),
    webReceiverId('http://sa4bna.hopto.org:8074/'),
  );
});

test('normalizeReceiverbookSites parses the embedded array and infers coverage from labels', () => {
  const rows = normalizeReceiverbookSites(RECEIVERBOOK_HTML);
  assert.deepEqual(
    rows.map((row) => row.url),
    [
      'http://sdrpt.dynip.sapo.pt:8074/',
      'http://sdrpt.dynip.sapo.pt:8073/',
      'http://websdr.ewi.utwente.nl:8901/',
      'http://sa4bna.hopto.org:8073/',
      'https://paris.example.org/rx/',
    ],
    'private, local and null-island receivers are dropped',
  );
  assert.equal(rows[0].type, 'openwebrx');
  assert.equal(rows[2].type, 'websdr');
  assert.equal(rows[3].type, 'kiwisdr');
  assert.equal(rows[0].lat, 39.2939);
  assert.equal(rows[0].lon, -8.7457);
  assert.deepEqual(
    rows[0].bands.map((band) => band.label),
    ['Airband'],
  );
  assert.ok(
    rows[2].bands.some(
      (band) => band.lowHz === 0 && band.highHz === 29_000_000,
    ),
  );
  assert.deepEqual(
    rows[4].bands.map((band) => band.label),
    ['2 m'],
  );
  assert.equal(rows[4].site, 'Odd "quoted" [site]');
  assert.deepEqual(rows[0].sources, ['receiverbook']);
  assert.throws(
    () => normalizeReceiverbookSites('<html>no data</html>'),
    /not found/,
  );
});

test('normalizeKiwiSdrRows reads gps, bands, slots and online state', () => {
  const rows = normalizeKiwiSdrRows(KIWI_JS);
  assert.equal(rows.length, 2, 'rows without gps are dropped');
  assert.equal(rows[0].url, 'http://sa4bna.hopto.org:8073/');
  assert.deepEqual(rows[0].bands, [
    { lowHz: 0, highHz: 30_000_000, label: '0–30 MHz' },
  ]);
  assert.equal(rows[0].users, 3);
  assert.equal(rows[0].usersMax, 8);
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].antenna, '100 mtr beverage');
  assert.equal(rows[0].site, 'Glava , Arvika');
  assert.equal(rows[1].online, false);
  assert.throws(() => normalizeKiwiSdrRows('var x = 1;'), /not found/);
});

test('mergeWebReceivers enriches Receiverbook rows with KiwiSDR data and adds unknown Kiwis', () => {
  const merged = mergeWebReceivers({
    receiverbook: normalizeReceiverbookSites(RECEIVERBOOK_HTML),
    kiwisdr: normalizeKiwiSdrRows(KIWI_JS),
  });
  const arvika = merged.find(
    (row) => row.url === 'http://sa4bna.hopto.org:8073/',
  );
  assert.equal(arvika.users, 3);
  assert.equal(arvika.online, true);
  assert.deepEqual(arvika.sources, ['receiverbook', 'kiwisdr']);
  assert.equal(
    arvika.bands[0].highHz,
    30_000_000,
    'published Kiwi coverage replaces the label guess',
  );
  assert.equal(arvika.coverage.hf, true);
  assert.equal(arvika.coverage.vhf, false);
  const sleepy = merged.find(
    (row) => row.url === 'http://sleepy.example.net:8073/',
  );
  assert.deepEqual(sleepy.sources, ['kiwisdr']);
  assert.equal(sleepy.online, false);
  assert.equal(merged.length, 6);
  assert.deepEqual(
    [...merged]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => row.name),
    merged.map((row) => row.name),
    'sorted by name',
  );
});

function bigReceiverbook(count) {
  const sites = Array.from({ length: count }, (_, index) => ({
    label: `Site ${index}`,
    location: {
      coordinates: [10 + index * 0.01, 50 + index * 0.01],
      type: 'Point',
    },
    receivers: [
      {
        label: `RX ${index} 0-30 MHz`,
        url: `http://rx${index}.example.org:8073/`,
        type: 'OpenWebRX',
      },
    ],
  }));
  return `<script>var receivers = ${JSON.stringify(sites)};</script>`;
}

test('the middleware serves a merged catalog, caches it, and degrades when one directory fails', async () => {
  let now = 1_000_000;
  let kiwiFailures = 0;
  const { fetchImpl, calls } = createFetch({
    'https://www.receiverbook.de/map': () => fakeResponse(bigReceiverbook(60)),
    'http://rx.linkfanel.net/kiwisdr_com.js': () => {
      kiwiFailures += 1;
      return fakeResponse('', 503);
    },
  });
  const middleware = createWebReceiversProxyMiddleware({
    fetchImpl,
    lookupImpl: publicLookup,
    now: () => now,
  });

  const first = fakeRes();
  await middleware(fakeReq(), first);
  assert.equal(first.status, 200);
  const body = first.json();
  assert.equal(body.receivers.length, 60);
  assert.equal(
    body.degraded,
    true,
    'one failed directory marks the catalog degraded',
  );
  assert.equal(body.sources.receiverbook.ok, true);
  assert.equal(body.sources.kiwisdr.ok, false);
  assert.match(body.sources.kiwisdr.error, /503/);
  assert.equal(body.stale, false);
  assert.equal(typeof body.updatedAt, 'string');
  assert.equal(calls.length, 2);

  const second = fakeRes();
  await middleware(fakeReq(), second);
  assert.equal(calls.length, 2, 'served from cache inside the TTL');

  now += 31 * 60 * 1000;
  const third = fakeRes();
  await middleware(fakeReq(), third);
  assert.equal(calls.length, 4, 'refreshed after the TTL');
  assert.equal(kiwiFailures, 2);
});

test('the middleware refuses redirects, serves stale after an outage, and 503s cold', async () => {
  let now = 5_000_000;
  let mode = 'ok';
  const { fetchImpl } = createFetch({
    'https://www.receiverbook.de/map': () =>
      mode === 'ok'
        ? fakeResponse(bigReceiverbook(70))
        : new Response('', {
            status: 302,
            headers: { Location: 'https://evil.example/' },
          }),
    'http://rx.linkfanel.net/kiwisdr_com.js': () =>
      mode === 'ok' ? fakeResponse(KIWI_JS) : fakeResponse('', 500),
  });
  const middleware = createWebReceiversProxyMiddleware({
    fetchImpl,
    lookupImpl: publicLookup,
    now: () => now,
  });

  const warm = fakeRes();
  await middleware(fakeReq(), warm);
  assert.equal(warm.status, 200);
  assert.equal(warm.json().degraded, false);
  assert.equal(warm.json().receivers.length, 72);

  mode = 'broken';
  now += 31 * 60 * 1000;
  const stale = fakeRes();
  await middleware(fakeReq(), stale);
  assert.equal(stale.status, 200);
  assert.equal(stale.json().stale, true);
  assert.equal(stale.json().degraded, true);
  assert.match(stale.json().degradedReason, /only 0 receivers/);

  const cold = createWebReceiversProxyMiddleware({
    fetchImpl,
    lookupImpl: publicLookup,
    now: () => now,
  });
  const failed = fakeRes();
  await cold(fakeReq(), failed);
  assert.equal(failed.status, 503);
  assert.equal(failed.json().degraded, true);
  assert.equal(failed.json().sources.receiverbook.ok, false);
  assert.match(
    failed.json().sources.receiverbook.error,
    /redirects are refused/,
  );
});

test('the middleware rejects forbidden resolved addresses and unknown routes', async () => {
  const { fetchImpl, calls } = createFetch({
    'https://www.receiverbook.de/map': () => fakeResponse(bigReceiverbook(70)),
    'http://rx.linkfanel.net/kiwisdr_com.js': () => fakeResponse(KIWI_JS),
  });
  const privateLookup = async () => [{ address: '10.0.0.7', family: 4 }];
  const middleware = createWebReceiversProxyMiddleware({
    fetchImpl,
    lookupImpl: privateLookup,
  });
  const res = fakeRes();
  await middleware(fakeReq(), res);
  assert.equal(res.status, 503);
  assert.equal(
    calls.length,
    0,
    'no request leaves when DNS resolves to a private address',
  );

  const unknown = fakeRes();
  await middleware(fakeReq('GET', '/anything'), unknown);
  assert.equal(unknown.status, 404);

  const wrongMethod = fakeRes();
  await middleware(fakeReq('POST', '/catalog'), wrongMethod);
  assert.equal(wrongMethod.status, 405);
});

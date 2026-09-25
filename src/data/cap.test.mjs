import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCap } from './cap.js';
import { createCapState } from './capState.js';
import {
  CAP_SOURCES,
  capProxy,
  extractCapLinks,
} from '../../server/providers/cap.js';

test('catalogue keeps supplied endpoints and formats', () => {
  assert.equal(
    CAP_SOURCES.inmet.url,
    'https://apiprevmet3.inmet.gov.br/avisos/rss',
  );
  assert.equal(CAP_SOURCES.nws.format, 'atom');
  assert.equal(CAP_SOURCES['met-norway'].format, 'cap');
});
test('pure RSS/Atom link whitelist accepts same path only', () => {
  const s = CAP_SOURCES.inmet;
  assert.deepEqual(
    extractCapLinks(
      '<item><link>https://apiprevmet3.inmet.gov.br/avisos/rss/a.xml</link></item><link href="https://evil.example/x"/>',
      s,
    ),
    ['https://apiprevmet3.inmet.gov.br/avisos/rss/a.xml'],
  );
});
test('uncertain catalogues stay disabled and opt-in is recognized', () => {
  assert.equal(CAP_SOURCES.eccc.enabled, false);
  const old = process.env.CAP_OPT_IN_SOURCES;
  process.env.CAP_OPT_IN_SOURCES = 'eccc';
  assert.ok(
    capProxy({
      sources: { eccc: CAP_SOURCES.eccc },
      fetchImpl: async () => {
        throw Error('offline');
      },
    }),
  );
  if (old === undefined) delete process.env.CAP_OPT_IN_SOURCES;
  else process.env.CAP_OPT_IN_SOURCES = old;
});

const cap = (body) =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>a</identifier><sender>x</sender><sent>2026-01-01T00:00:00Z</sent>${body}</alert>`;
test('default namespace', () =>
  assert.equal(parseCap(cap('<msgType>Alert</msgType>'))[0].msgType, 'Alert'));
test('prefixed namespace', () =>
  assert.equal(
    parseCap(
      cap('<cap:info xmlns:cap="urn:x"><cap:event>Fire</cap:event></cap:info>'),
    )[0].info[0].event,
    'Fire',
  ));
test('CDATA and entities', () =>
  assert.equal(
    parseCap(
      cap('<info><description><![CDATA[A &amp; B]]></description></info>'),
    )[0].info[0].description,
    'A & B',
  ));
test('info fields and areas', () => {
  const a = parseCap(
    cap(
      '<info><urgency>Immediate</urgency><area><areaDesc>Zone</areaDesc><geocode><value>1</value></geocode></area></info>',
    ),
  )[0];
  assert.equal(a.info[0].urgency, 'Immediate');
  assert.equal(a.info[0].areas[0].description, 'Zone');
});
test('polygon lat lon', () =>
  assert.deepEqual(
    parseCap(cap('<info><area><polygon>1,2 3,4 5,6</polygon></area></info>'))[0]
      .info[0].areas[0].geometry.coordinates[0],
    [1, 2],
  ));
test('circle', () =>
  assert.equal(
    parseCap(cap('<info><area><circle>1,2 5</circle></area></info>'))[0].info[0]
      .areas[0].geometry.radiusKm,
    5,
  ));
test('truncated and malicious XML rejected', () => {
  assert.throws(() => parseCap(cap('<info>')));
  assert.throws(() => parseCap('<!DOCTYPE alert [<!ENTITY x "y">]><alert/>'));
});
test('byte and item limits', () => {
  assert.throws(() =>
    parseCap(cap('<description>x</description>'), { maxBytes: 5 }),
  );
  assert.throws(() =>
    parseCap(
      '<alert><identifier>x</identifier></alert><alert><identifier>y</identifier></alert>',
      { maxItems: 1 },
    ),
  );
});
test('alert then update preserves target identity', () => {
  const s = createCapState();
  s.ingest([
    { identifier: 'a', sent: '2026-01-01T00:00:00Z', msgType: 'Alert' },
  ]);
  assert.equal(
    s.ingest([
      {
        identifier: 'u',
        references: 'sender,a,2026-01-01T00:00:00Z',
        sent: '2026-01-02T00:00:00Z',
        msgType: 'Update',
      },
    ])[0].identifier,
    'a',
  );
});
test('cancel prevents resurrection and old versions', () => {
  const s = createCapState();
  s.ingest([
    { identifier: 'a', sent: '2026-01-02T00:00:00Z', msgType: 'Alert' },
  ]);
  s.ingest([{ identifier: 'c', references: 'sender,a,t', msgType: 'Cancel' }]);
  assert.equal(
    s.ingest([
      { identifier: 'a', sent: '2026-01-03T00:00:00Z', msgType: 'Alert' },
    ]).length,
    0,
  );
});
test('expiration uses injected now', () => {
  let t = 0;
  const s = createCapState({ now: () => t });
  s.ingest([
    {
      identifier: 'a',
      sent: '2026-01-01T00:00:00Z',
      msgType: 'Alert',
      info: [{ expires: '1970-01-01T00:00:10Z' }],
    },
  ]);
  t = 11000;
  assert.equal(s.snapshot().length, 0);
});
test('provider uses catalog and tolerates partial failure', async () => {
  const xml = cap('');
  const fetchImpl = async (url) => {
    if (url === CAP_SOURCES['met-norway'].url)
      return { ok: true, headers: new Headers(), text: async () => xml };
    throw Error('offline');
  };
  const p = capProxy({
    fetchImpl,
    sources: {
      good: CAP_SOURCES['met-norway'],
      bad: { url: 'https://catalog.invalid', region: 'x' },
    },
  });
  const res = {
    body: '',
    setHeader() {},
    end(x) {
      this.body = x;
    },
  };
  await p.handle({ url: '/api/cap' }, res, () => {});
  assert.equal(JSON.parse(res.body).alerts.length, 1);
});

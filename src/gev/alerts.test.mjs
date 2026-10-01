import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStore } from '../../server/providers/store/store.js';
import { sqliteDriver } from '../../server/providers/store/drivers.js';
import {
  createRuleEngine,
  validateRule,
  validateFence,
  validateWatchlist,
  pointInPolygon,
} from '../sources/alertRules.js';
import { createAlertService } from '../../server/providers/alerts/index.js';
import { validateChannel, maskChannel, createDeliverer } from '../../server/providers/alerts/channels.js';
import { parseTle, nextPass } from '../../server/providers/alerts/satellites.js';
import { isWatched } from '../../server/providers/common/watchRegistry.js';

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const MIN = 60_000;
const box = { id: 'box', name: 'Box', shape: { type: 'polygon', coords: [[-122, 37], [-121, 37], [-121, 38], [-122, 38]] } };
const ring = { id: 'ring', name: 'Ring', shape: { type: 'circle', center: [-121.5, 37.5], radiusM: 5000 } };
const obs = (id, t, lat, lon, extra = {}) => ({ domain: 'air', id, t, lat, lon, label: 'TST1', speed: 200, alt: 5000, ...extra });

test('point in polygon and fence validation', () => {
  assert.ok(pointInPolygon(-121.5, 37.5, box.shape.coords));
  assert.ok(!pointInPolygon(-120, 37.5, box.shape.coords));
  assert.throws(() => validateFence({ name: 'x', shape: { type: 'circle', center: [0, 0], radiusM: 10 } }), /radius/);
  assert.throws(() => validateFence({ name: 'x', shape: { type: 'polygon', coords: [[0, 0], [1, 1]] } }), /3 to 2000/);
  assert.throws(() => validateFence({ name: 'x', shape: { type: 'polygon', coords: [[-179, 0], [179, 0], [179, 1]] } }), /antimeridian/);
});

test('watchlist validation enforces id formats', () => {
  assert.throws(() => validateWatchlist({ name: 'w', entries: [{ domain: 'air', id: 'zzz' }] }), /ICAO/);
  assert.throws(() => validateWatchlist({ name: 'w', entries: [{ domain: 'sea', id: '12' }] }), /MMSI/);
  assert.throws(() => validateWatchlist({ name: 'w', entries: [{ domain: 'space', label: 'ISS' }] }), /NORAD/);
  const w = validateWatchlist({ name: 'w', entries: [{ domain: 'air', id: 'ABC123' }, { domain: 'air', label: 'n911' }] });
  assert.deepEqual(w.entries.map((e) => e.id || e.label), ['abc123', 'N911']);
});

test('fence enter/exit fire on transitions only, not on first sighting', () => {
  const rule = { id: 'r1', name: 'enter', kind: 'fence-enter', severity: 'warning', scope: {}, params: { fenceId: 'box' } };
  const exit = { ...rule, id: 'r2', kind: 'fence-exit' };
  const e = createRuleEngine({ fences: [box], rules: [rule, exit] });
  assert.equal(e.evaluate(obs('aaa111', T0, 37.5, -121.5)).length, 0, 'already inside: no alert');
  assert.equal(e.evaluate(obs('bbb222', T0, 37.5, -120)).length, 0);
  const enter = e.evaluate(obs('bbb222', T0 + MIN, 37.5, -121.5));
  assert.equal(enter.length, 1);
  assert.equal(enter[0].kind, 'fence-enter');
  assert.match(enter[0].title, /TST1 entered Box/);
  assert.equal(e.evaluate(obs('bbb222', T0 + 2 * MIN, 37.6, -121.5)).length, 0, 'no duplicate while inside');
  const left = e.evaluate(obs('bbb222', T0 + 3 * MIN, 39, -121.5));
  assert.deepEqual(left.map((x) => x.kind), ['fence-exit']);
});

test('dwell, squawk, speed band, loiter, dark and appear', () => {
  const rules = [
    { id: 'd', name: 'dwell', kind: 'fence-dwell', scope: {}, params: { fenceId: 'ring', minutes: 10 } },
    { id: 's', name: 'sq', kind: 'squawk', scope: { domain: 'air' }, params: { codes: ['7700'] } },
    { id: 'v', name: 'slow', kind: 'speed', scope: {}, params: { max: 300 } },
    { id: 'l', name: 'loiter', kind: 'loiter', scope: { domain: 'air' }, params: { radiusM: 3000, minutes: 10 } },
    { id: 'k', name: 'dark', kind: 'dark', scope: { watchlistId: 'w' }, params: { minutes: 30 } },
    { id: 'a', name: 'appear', kind: 'appear', scope: { watchlistId: 'w' }, params: { gapMinutes: 60 } },
  ];
  const watchlists = [{ id: 'w', name: 'W', entries: [{ domain: 'air', id: 'ccc333' }] }];
  const e = createRuleEngine({ fences: [ring], rules, watchlists }, { cooldownMs: 15 * MIN });

  // dwell: outside, then in, then still in after 10 min
  e.evaluate(obs('ddd444', T0, 38, -120));
  e.evaluate(obs('ddd444', T0 + MIN, 37.5, -121.5));
  const dwell = e.evaluate(obs('ddd444', T0 + 12 * MIN, 37.501, -121.5));
  assert.ok(dwell.some((x) => x.kind === 'fence-dwell'));

  // squawk fires once per code activation
  assert.equal(e.evaluate(obs('eee555', T0, 0, 0, { squawk: '7700' })).filter((x) => x.kind === 'squawk').length, 1);
  assert.equal(e.evaluate(obs('eee555', T0 + MIN, 0, 0, { squawk: '7700' })).filter((x) => x.kind === 'squawk').length, 0);
  e.evaluate(obs('eee555', T0 + 2 * MIN, 0, 0, { squawk: '1200' }));
  assert.equal(e.evaluate(obs('eee555', T0 + 3 * MIN, 0, 0, { squawk: '7700' })).filter((x) => x.kind === 'squawk').length, 1);

  // speed band crossing
  assert.equal(e.evaluate(obs('fff666', T0, 0, 0, { speed: 350 })).filter((x) => x.kind === 'speed').length, 1);
  assert.equal(e.evaluate(obs('fff666', T0 + MIN, 0, 0, { speed: 360 })).filter((x) => x.kind === 'speed').length, 0);

  // loiter: circling a 2 km orbit for 12 min
  let loiter = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 6) * 2 * Math.PI;
    loiter = loiter.concat(
      e.evaluate(obs('aaa999', T0 + i * 30_000, 10 + 0.018 * Math.sin(a), 10 + 0.018 * Math.cos(a))).filter((x) => x.kind === 'loiter'),
    );
  }
  assert.equal(loiter.length, 1, 'loiter fires once within cooldown');

  // dark + appear for the watched asset
  e.evaluate(obs('ccc333', T0, 1, 1));
  assert.equal(e.tick(T0 + 20 * MIN).length, 0);
  const dark = e.tick(T0 + 31 * MIN);
  assert.deepEqual(dark.map((x) => x.kind), ['dark']);
  assert.equal(e.tick(T0 + 40 * MIN).length, 0, 'dark fires once until seen again');
  const back = e.evaluate(obs('ccc333', T0 + 90 * MIN, 1, 1));
  assert.ok(back.some((x) => x.kind === 'appear'));
  assert.deepEqual(e.watchedIdKeys(), ['air:ccc333']);
});

test('label-prefix watchlists match callsigns', () => {
  const e = createRuleEngine({
    watchlists: [{ id: 'w', name: 'W', entries: [{ domain: 'air', label: 'N911' }] }],
    rules: [{ id: 'v', name: 'v', kind: 'speed', scope: { watchlistId: 'w' }, params: { min: 0 } }, { id: 'x', name: 'x', kind: 'altitude', scope: { watchlistId: 'w' }, params: { max: 100 } }],
  });
  assert.equal(e.evaluate(obs('abc001', T0, 0, 0, { label: 'N911XY', alt: 200 })).length, 1);
  assert.equal(e.evaluate(obs('abc002', T0, 0, 0, { label: 'UAL911', alt: 200 })).length, 0);
});

test('rule validation', () => {
  const ctx = { fences: [box], watchlists: [{ id: 'w', entries: [] }], channels: [{ id: 'c' }] };
  assert.throws(() => validateRule({ name: 'x', kind: 'nope' }, ctx), /kind/);
  assert.throws(() => validateRule({ name: 'x', kind: 'fence-enter', params: { fenceId: 'zzz' } }, ctx), /unknown fence/);
  assert.throws(() => validateRule({ name: 'x', kind: 'dark', params: { minutes: 30 } }, ctx), /watchlist/);
  assert.throws(() => validateRule({ name: 'x', kind: 'squawk', channels: ['nope'] }, ctx), /channel/);
  const sq = validateRule({ name: 'x', kind: 'squawk', channels: ['c'] }, ctx);
  assert.deepEqual(sq.params.codes, ['7500', '7600', '7700']);
  assert.equal(sq.scope.domain, 'air');
  const oh = validateRule({ name: 'iss', kind: 'overhead', scope: { watchlistId: 'w' }, params: { fenceId: 'box' } }, ctx);
  assert.equal(oh.params.minElevDeg, 20);
});

test('channels only accept allowlisted HTTPS webhook hosts and are masked', () => {
  assert.throws(() => validateChannel({ name: 's', type: 'slack', url: 'http://hooks.slack.com/services/x' }), /https/);
  assert.throws(() => validateChannel({ name: 's', type: 'slack', url: 'https://evil.example/services/x' }), /host/);
  assert.throws(() => validateChannel({ name: 's', type: 'slack', url: 'https://hooks.slack.com:444/services/x' }), /port/);
  assert.throws(() => validateChannel({ name: 'w', type: 'webhook', url: 'https://ntfy.sh/x' }, {}), /GEV_WEBHOOK_HOSTS/);
  assert.throws(() => validateChannel({ name: 'w', type: 'webhook', url: 'https://169.254.169.254/x' }, { GEV_WEBHOOK_HOSTS: 'ntfy.sh' }), /host/);
  const ok = validateChannel({ name: 'w', type: 'webhook', url: 'https://ntfy.sh/topic' }, { GEV_WEBHOOK_HOSTS: 'ntfy.sh' });
  assert.equal(ok.url, 'https://ntfy.sh/topic');
  const masked = maskChannel({ id: 'c', ...validateChannel({ name: 's', type: 'slack', url: 'https://hooks.slack.com/services/T000/B000/SECRETSECRET' }) });
  assert.ok(!masked.url.includes('SECRET'));
});

test('deliverer posts the right payload and rate limits', async () => {
  const calls = [];
  const d = createDeliverer({ fetchImpl: async (url, init) => (calls.push({ url, init }), { ok: true }), perMinute: 2, now: () => T0 });
  const ch = { id: 'c', name: 'd', type: 'discord', url: 'https://discord.com/api/webhooks/1/abc' };
  const alert = { id: 'a', t: T0, kind: 'squawk', severity: 'critical', title: 'X squawking 7700', lat: 1, lon: 2 };
  assert.deepEqual(await d.deliver(ch, alert), { ok: true });
  assert.match(JSON.parse(calls[0].init.body).content, /\[CRITICAL\] X squawking 7700/);
  assert.equal(calls[0].init.redirect, 'error');
  await d.deliver(ch, alert);
  assert.deepEqual(await d.deliver(ch, alert), { ok: false, reason: 'rate_limited' });
});

// ISS TLE (historic epoch; pass math only, not a live prediction).
const ISS = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000+0  30164-3 0  9993
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50238117432690`;

test('TLE parsing and pass prediction', () => {
  const tle = parseTle(ISS);
  assert.equal(tle.name, 'ISS (ZARYA)');
  const pass = nextPass(tle, { lat: 38.5, lon: -121.7, fromMs: Date.UTC(2024, 0, 1, 12), minElevDeg: 10, horizonHours: 24 });
  assert.ok(pass && pass.setMs > pass.riseMs && pass.maxElevDeg >= 10);
  assert.equal(parseTle('garbage'), null);
});

test('alert service: CRUD, simulate, persist, SSE and watch registry', async () => {
  const store = createStore(await sqliteDriver(':memory:'));
  await store.init();
  let t = T0;
  const svc = createAlertService({
    getStore: async () => store,
    deliverer: createDeliverer({ fetchImpl: async () => ({ ok: true }) }),
    getTle: async () => parseTle(ISS),
    now: () => t,
    env: {},
  });
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/watch/, '') || '/';
    svc.handler(req, res, () => {
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/watch`;
  const put = (p, body) => fetch(`${base}${p}`, { method: 'PUT', body: JSON.stringify(body) });
  try {
    assert.equal((await put('/fences/Bad_ID', box)).status, 400);
    assert.equal((await put('/fences/box', box)).status, 200);
    assert.equal((await put('/watchlists/vip', { name: 'VIP', entries: [{ domain: 'air', id: 'abc123' }] })).status, 200);
    assert.ok(isWatched('air', 'abc123'), 'registry updated for history pinning');
    let r = await put('/rules/enter', { name: 'Enter box', kind: 'fence-enter', severity: 'warning', params: { fenceId: 'box' } });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/fences/box`, { method: 'DELETE' });
    assert.equal(r.status, 409, 'fence in use by a rule');

    const stream = await fetch(`${base}/stream`);
    const reader = stream.body.getReader();
    const firstEvent = (async () => {
      let text = '';
      while (!text.includes('event: alert')) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    })();

    r = await fetch(`${base}/simulate`, {
      method: 'POST',
      body: JSON.stringify({ observations: [obs('abc123', T0, 36, -121.5), obs('abc123', T0 + MIN, 37.5, -121.5)] }),
    });
    const sim = await r.json();
    assert.equal(sim.fired.length, 1);
    assert.match(await firstEvent, /entered Box/);
    await reader.cancel();

    r = await fetch(`${base}/alerts?since=${T0 - 1}`);
    const { alerts } = await r.json();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].owner, undefined, 'owner not leaked');
    r = await fetch(`${base}/alerts/${alerts[0].id}/ack`, { method: 'POST' });
    assert.equal(r.status, 200);

    r = await fetch(`${base}/state`);
    const state = await r.json();
    assert.deepEqual(state.rules.map((x) => x.id), ['enter']);

    r = await fetch(`${base}/passes?norad=25544&lat=38.5&lon=-121.7&hours=1`);
    assert.equal(r.status, 200);
    r = await fetch(`${base}/passes?norad=abc&lat=1&lon=1`);
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachVoiceResult } from './speech.js';
import { resolveDeicticArgs } from './deixis.js';
import { createReferentRegistry, referentsFromResult } from './referents.js';

const aircraft = {
  fresh: true,
  at: 'speech_start',
  target: 'entity',
  entity: { layerId: 'flights', id: 'a1b2c3', label: 'UPS793', kind: 'aircraft' },
  lat: 30.2,
  lon: -97.7,
  radiusKm: 20,
};
const ground = { fresh: true, at: 'keydown', target: 'ground', entity: null, lat: 30.27, lon: -97.74, radiusKm: 8 };
const datacenter = {
  ...aircraft,
  entity: { layerId: 'local-datacenters', id: 'dc-7', label: 'Data Center 7', kind: 'feature' },
};

test('track_entity: "track that one" follows the pointed aircraft by identity', () => {
  const out = resolveDeicticArgs('track_entity', { query: 'pointer' }, { pointer: aircraft });
  assert.equal(out.error, null);
  assert.deepEqual(out.args, { query: 'a1b2c3', layerId: 'flights' });
  assert.deepEqual(out.used, { source: 'pointer', label: 'UPS793', layerId: 'flights' });
});

test('track_entity: pointer misses are plain errors the model can say', () => {
  assert.match(resolveDeicticArgs('track_entity', { query: 'Pointer' }, { pointer: null }).error, /Nothing is under the pointer/);
  assert.match(resolveDeicticArgs('track_entity', { query: 'pointer' }, { pointer: ground }).error, /on the ground/);
  assert.match(resolveDeicticArgs('track_entity', { query: 'pointer' }, { pointer: datacenter }).error, /cannot be followed/);
});

test('names are untouched: a real query never reads the pointer', () => {
  const args = { query: 'UAL428' };
  const out = resolveDeicticArgs('track_entity', args, { pointer: aircraft });
  assert.equal(out.args, args);
  assert.equal(out.used, null);
  assert.equal(resolveDeicticArgs('set_hud', { enabled: true }, { pointer: aircraft }).used, null);
});

test('fly_to_location: "take me there" flies to the pointed ground point', () => {
  const out = resolveDeicticArgs('fly_to_location', { query: 'pointer', rangeM: 2000 }, { pointer: ground });
  assert.deepEqual(out.args, { rangeM: 2000, latitude: 30.27, longitude: -97.74 });
  assert.equal(out.used.source, 'pointer');
});

test('get_entity_context: pointer scope targets the entity; no pointer falls back to auto', () => {
  const out = resolveDeicticArgs('get_entity_context', { scope: 'pointer' }, { pointer: aircraft });
  assert.equal(out.args.scope, 'target');
  assert.equal(out.args.target.id, 'a1b2c3');
  assert.equal(out.args.target.lat, 30.2);
  const fallback = resolveDeicticArgs('get_entity_context', { scope: 'pointer' }, { pointer: null });
  assert.equal(fallback.error, null, 'a read-only lookup never fails for a missing pointer');
  assert.equal(fallback.args.scope, 'auto');
  assert.equal(fallback.used.missing, true);
});

test('analyst_query: "how many flights around here" becomes a radius at the pointer', () => {
  const out = resolveDeicticArgs(
    'analyst_query',
    { layers: ['flights'], scope: { kind: 'pointer' } },
    { pointer: ground },
  );
  assert.deepEqual(out.args.scope, { kind: 'radius', center: { lat: 30.27, lon: -97.74 }, km: 8 });
  const explicit = resolveDeicticArgs('analyst_query', { scope: { kind: 'pointer', km: 100 } }, { pointer: ground });
  assert.equal(explicit.args.scope.km, 100, 'an explicit radius wins');
  assert.match(resolveDeicticArgs('analyst_query', { scope: { kind: 'pointer' } }, {}).error, /Nothing is under/);
});

test('annotate_map: pointer targets become coordinates and keep the label', () => {
  const out = resolveDeicticArgs(
    'annotate_map',
    {
      annotations: [
        { type: 'pin', target: 'pointer' },
        { type: 'arrow', target: 'Texas State Capitol', toTarget: 'pointer' },
        { type: 'route', points: [{ target: 'Zilker Park' }, { target: 'pointer' }] },
      ],
    },
    { pointer: aircraft },
  );
  const [pin, arrow, route] = out.args.annotations;
  assert.deepEqual(pin, { type: 'pin', latitude: 30.2, longitude: -97.7, label: 'UPS793' });
  assert.deepEqual(arrow, { type: 'arrow', target: 'Texas State Capitol', toLatitude: 30.2, toLongitude: -97.7 });
  assert.deepEqual(route.points[1], { latitude: 30.2, longitude: -97.7 });
});

test('referents: numbered items resolve for track, fly and context', () => {
  const referents = createReferentRegistry();
  referents.recordResult('frame_overhead', {
    ok: true,
    display: { title: '3 aircraft in frame' },
    referents: [
      { n: 1, id: 'aaa111', label: 'SWA12', layerId: 'flights' },
      { n: 2, id: 'bbb222', label: 'UPS793', layerId: 'flights' },
      { n: 3, id: 'ccc333', label: 'AAL9', layerId: 'flights' },
    ],
  });
  const track = resolveDeicticArgs('track_entity', { query: 'second one', referent: 2 }, { referents });
  assert.deepEqual(track.args, { query: 'bbb222', layerId: 'flights' });
  assert.equal(track.used.source, 'referent');
  const last = resolveDeicticArgs('track_entity', { query: 'x', referent: -1 }, { referents });
  assert.equal(last.args.query, 'ccc333', '-1 is the last one');
  const fly = resolveDeicticArgs('fly_to_location', { referent: 1 }, { referents });
  assert.deepEqual(fly.args, { entity: { layerId: 'flights', id: 'aaa111' } }, 'moving contacts are located at run time');
  const context = resolveDeicticArgs('get_entity_context', { referent: 3 }, { referents });
  assert.equal(context.args.scope, 'target');
  assert.equal(context.args.target.label, 'AAL9');
  assert.match(resolveDeicticArgs('track_entity', { query: 'x', referent: 7 }, { referents }).error, /no item 7/);
});

test('referents: map marks fly by name and cannot be tracked', () => {
  const referents = createReferentRegistry();
  referents.recordResult('annotate_map', {
    ok: true,
    display: { title: 'Marked 2 places' },
    referents: [
      { n: 1, id: 'anno-1', label: 'Texas State Capitol' },
      { n: 2, id: 'anno-2', label: 'Zilker Park' },
    ],
  });
  assert.deepEqual(resolveDeicticArgs('fly_to_location', { referent: 2 }, { referents }).args, { query: 'Zilker Park' });
  assert.match(resolveDeicticArgs('track_entity', { query: 'x', referent: 1 }, { referents }).error, /cannot be followed/);
});

test('registry: mirrors the card, records analyst items, clears per session', () => {
  const referents = createReferentRegistry();
  assert.equal(
    referents.recordResult('get_current_view_state', { ok: true, schedule: 'silent', display: { title: 'View' }, referents: [{ n: 1, label: 'x' }] }),
    false,
    'silent lookups do not replace the list',
  );
  assert.equal(referents.recordResult('fly_to_location', { ok: false, referents: [{ n: 1, label: 'x' }] }), false);
  referents.recordResult('analyst_query', {
    ok: true,
    items: [
      { layerKey: 'flights', id: 'abc', callsign: 'DAL1', latitude: 1, longitude: 2 },
      { layerKey: 'military', id: 'def' },
    ],
  });
  assert.deepEqual(referents.get(1), { n: 1, id: 'abc', label: 'DAL1', layerId: 'flights', lat: 1, lon: 2 });
  assert.equal(referents.get(2).label, 'def');
  assert.equal(referents.recordResult('track_entity', { ok: true, label: 'DAL1' }), false, 'results without a list keep it');
  assert.equal(referents.list().length, 2);
  referents.clear();
  assert.equal(referents.get(1), null);
  assert.deepEqual(referentsFromResult('x', null), []);
});

test('registry: hidden card rows never resolve and last means displayed item five', () => {
  const referents = createReferentRegistry();
  referents.recordResult('analyst_query', {
    ok: true,
    count: 6,
    scopeLabel: 'anywhere',
    coverage: { layersQueried: [{ layerKey: 'flights' }] },
    items: Array.from({ length: 6 }, (_, index) => ({
      layerKey: 'flights',
      id: `F${index + 1}`,
    })),
  });
  assert.deepEqual(
    referents.list().map((entry) => entry.n),
    [1, 2, 3, 4, 5],
  );
  assert.equal(referents.get(6), null);
  assert.equal(referents.get(-1)?.id, 'F5');
});


test('numbered custom-labeled pins retain their resolved coordinates', () => {
  const referents = createReferentRegistry();
  const result = attachVoiceResult('annotate_map', {
    ok: true,
    items: [{ ok: true, id: 'pin-1', label: 'Meeting point', latitude: 30.27, longitude: -97.74 }],
  });
  referents.recordResult('annotate_map', result);
  assert.deepEqual(resolveDeicticArgs('fly_to_location', { referent: 1 }, { referents }).args,
    { latitude: 30.27, longitude: -97.74 });
});

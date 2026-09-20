import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PEER_PLACE_ALT_M,
  SHARE_ALERTS_STORAGE_KEY,
  applyPeerFrame,
  readShareAlerts,
  writeShareAlerts,
} from './peerFrames.js';
import { createLocalMemory } from './localMemory.js';
import { LOCAL_TOOL_PACKS, packHandlers, packSchemas } from './tools/index.js';
import * as peersPack from './tools/peers.js';
import { isLocalTool } from './localToolSchemas.js';

function mapStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

test('applyPeerFrame files a shared place as "<name> (from <peer>)" and toasts', () => {
  const memory = createLocalMemory({ storage: mapStorage(), now: () => 5 });
  const toasts = [];
  const result = applyPeerFrame(
    {
      type: 'peer_place',
      origin: 'office',
      place: { name: 'marina', lat: 47.6, lon: -122.3, alt: 800, heading: 90 },
    },
    { memory, toast: (text) => toasts.push(text) },
  );
  assert.deepEqual(result, {
    type: 'peer_place',
    peer: 'office',
    name: 'marina (from office)',
    place: {
      name: 'marina (from office)',
      lat: 47.6,
      lon: -122.3,
      alt: 800,
      heading: 90,
      pitch: -45,
      roll: 0,
      savedAt: 5,
    },
  });
  assert.deepEqual(toasts, ['office shared "marina" — saved as "marina (from office)"']);
  assert.equal(memory.recallPlace('marina').name, 'marina (from office)');
  assert.equal(memory.recallPlace('marina (from office)').lat, 47.6);
});

test('applyPeerFrame defaults the altitude, accepts a `peer` fallback and survives a throwing toast', () => {
  const memory = createLocalMemory({ storage: mapStorage() });
  const result = applyPeerFrame(
    { type: 'peer_place', peer: 'lab', place: { name: 'pier', lat: '1.5', lon: '2' } },
    {
      memory,
      toast: () => {
        throw new Error('no toast');
      },
    },
  );
  assert.equal(result.peer, 'lab');
  assert.equal(result.place.alt, DEFAULT_PEER_PLACE_ALT_M);
  assert.equal(result.place.lat, 1.5);
  assert.equal(result.place.lon, 2);
  assert.equal(applyPeerFrame({ type: 'peer_place', place: { name: 'x', lat: 1, lon: 2 } }, { memory }).peer, 'peer');
});

test('applyPeerFrame ignores anything that is not a usable peer_place', () => {
  const memory = createLocalMemory({ storage: mapStorage() });
  const toasts = [];
  const toast = (text) => toasts.push(text);
  for (const frame of [
    null,
    { type: 'notice', text: 'From A: hi', origin: 'A' },
    { type: 'peer_place' },
    { type: 'peer_place', place: { name: 'no coords' } },
    { type: 'peer_place', place: { lat: 1, lon: 2 } },
    { type: 'peer_place', place: { name: 'nan', lat: 'x', lon: 2 } },
  ])
    assert.equal(applyPeerFrame(frame, { memory, toast }), null, JSON.stringify(frame));
  assert.equal(applyPeerFrame({ type: 'peer_place', place: { name: 'x', lat: 1, lon: 2 } }, {}), null, 'no memory');
  assert.deepEqual(toasts, []);
  assert.deepEqual(memory.listPlaces(), []);
});

test('the share-alerts flag defaults on, round-trips through storage and tolerates a broken store', () => {
  const storage = mapStorage();
  assert.equal(readShareAlerts(storage), true);
  assert.equal(writeShareAlerts(false, storage), true);
  assert.equal(storage.map.get(SHARE_ALERTS_STORAGE_KEY), '0');
  assert.equal(readShareAlerts(storage), false);
  writeShareAlerts(true, storage);
  assert.equal(readShareAlerts(storage), true);
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readShareAlerts(broken), true);
  assert.equal(writeShareAlerts(false, broken), false);
  assert.equal(readShareAlerts(null), true);
});

test('the peers tool pack is registered and its tools count as local tools', () => {
  assert.ok(LOCAL_TOOL_PACKS.includes(peersPack));
  const names = packSchemas().map((tool) => tool.name);
  for (const name of ['peers_list', 'share_place', 'share_alerts']) {
    assert.ok(names.includes(name), name);
    assert.ok(isLocalTool(name), `${name} is a local tool`);
  }
  for (const schema of peersPack.schemas) {
    assert.equal(schema.parameters.type, 'object');
    assert.equal(schema.parameters.additionalProperties, false);
  }
});

test('peers_list summarises the route answer', async () => {
  const calls = [];
  const handlers = packHandlers({
    fetchJson: async (url, body) => {
      calls.push([url, body]);
      return {
        name: 'desk',
        peers: [
          { name: 'office', url: 'ws://o/api/voice/remote', connected: true, lastSeen: 1 },
          { name: 'lab:4327', url: 'ws://lab:4327/api/voice/remote', connected: false, lastSeen: null },
        ],
      };
    },
  });
  const result = await handlers.peers_list();
  assert.deepEqual(calls, [['/api/voice/peers', undefined]]);
  assert.deepEqual(result, {
    ok: true,
    me: 'desk',
    count: 2,
    connected: 1,
    peers: [
      { name: 'office', url: 'ws://o/api/voice/remote', connected: true },
      { name: 'lab:4327', url: 'ws://lab:4327/api/voice/remote', connected: false },
    ],
    summary: 'office (connected), lab:4327 (offline)',
  });
  const empty = packHandlers({ fetchJson: async () => ({ peers: [] }) });
  assert.equal((await empty.peers_list()).summary, 'No peer globes are configured (GEV_PEERS is empty).');
});

test('share_place looks the place up in memory and posts it to the route', async () => {
  const memory = createLocalMemory({ storage: mapStorage(), now: () => 7 });
  memory.rememberPlace('Home', { lat: 47.6, lon: -122.3, alt: 900, heading: 10, pitch: -30, roll: 0 });
  const calls = [];
  const handlers = packHandlers({
    memory,
    fetchJson: async (url, body) => {
      calls.push([url, body]);
      return { ok: true, sent: ['office'], peers: 2 };
    },
  });
  const missing = await handlers.share_place({ name: 'the marina' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No saved place named "the marina"/);
  assert.deepEqual(calls, []);

  const result = await handlers.share_place({ name: 'my home' });
  assert.deepEqual(calls, [
    [
      '/api/voice/peers',
      {
        op: 'share_place',
        place: { name: 'Home', lat: 47.6, lon: -122.3, alt: 900, heading: 10, pitch: -30, roll: 0 },
      },
    ],
  ]);
  assert.deepEqual(result, {
    ok: true,
    name: 'Home',
    sent: ['office'],
    peers: 2,
    summary: 'Sent "Home" to office.',
  });
  const offline = packHandlers({ memory, fetchJson: async () => ({ ok: true, sent: [], peers: 1 }) });
  assert.equal((await offline.share_place({ name: 'home' })).summary, 'No peer globe is connected right now; "Home" was not sent.');
});

test('share_alerts persists the per-browser flag', async () => {
  const storage = mapStorage();
  const handlers = packHandlers({ storage, fetchJson: async () => ({}) });
  assert.deepEqual(await handlers.share_alerts({ enabled: false }), { ok: true, enabled: false, persisted: true });
  assert.equal(readShareAlerts(storage), false);
  assert.deepEqual(await handlers.share_alerts({ enabled: true }), { ok: true, enabled: true, persisted: true });
  assert.deepEqual(await handlers.share_alerts({}), { ok: true, enabled: true, persisted: true });
});

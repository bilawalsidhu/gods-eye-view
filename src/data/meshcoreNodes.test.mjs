import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESHCORE_NODE_TYPE_LABELS,
  normalizeMeshcoreNode,
  normalizeMeshcoreNodes,
} from './meshcoreNodes.js';

function rawRepeater(overrides = {}) {
  return {
    public_key:
      '0100004bc4f2fb60969e32e99c87b74185d95222145ad4d9db0d590f8f7422b1',
    type: 2,
    adv_name: 'Kakadu 1 apolut net',
    last_advert: '2024-05-21T22:52:34.000Z',
    adv_lat: 48.0559,
    adv_lon: 11.521,
    inserted_date: '2026-08-11T22:47:39.000Z',
    updated_date: '2026-09-12T21:42:29.000Z',
    params: { freq: 869.6183, cr: 8, sf: 8, bw: 62.5 },
    link: 'meshcore://12000100004bc4f2fb60969e32e99c87b74185d95222145ad4d9db0d590f8f7422b1',
    source: 'uploader',
    inserted_by:
      '515fd528e5ab3a096b80946e8f894ff5fa452251e9e41f7860dbc3e54c209305',
    updated_by:
      '515fd528e5ab3a096b80946e8f894ff5fa452251e9e41f7860dbc3e54c209305',
    ...overrides,
  };
}

test('normalizeMeshcoreNode keeps only the fields the globe needs', () => {
  const node = normalizeMeshcoreNode(rawRepeater());
  assert.deepEqual(node, {
    id: '0100004bc4f2fb60969e32e99c87b74185d95222145ad4d9db0d590f8f7422b1',
    type: 2,
    name: 'Kakadu 1 apolut net',
    lat: 48.0559,
    lon: 11.521,
    updatedAt: Date.parse('2026-09-12T21:42:29.000Z'),
    source: 'uploader',
    freq: 869.618,
    bandwidth: 62.5,
    spreadingFactor: 8,
    codingRate: 8,
  });
  // The link/inserted_by/updated_by/inserted_date/last_advert fields — the
  // biggest contributors to the raw feed's size — must not survive.
  assert.equal(node.link, undefined);
  assert.equal(node.inserted_by, undefined);
});

test('MESHCORE_NODE_TYPE_LABELS covers every accepted type code', () => {
  for (const type of Object.keys(MESHCORE_NODE_TYPE_LABELS).map(Number)) {
    assert.ok(normalizeMeshcoreNode(rawRepeater({ type })));
  }
});

test('normalizeMeshcoreNode drops records with an unknown type', () => {
  assert.equal(normalizeMeshcoreNode(rawRepeater({ type: 99 })), null);
  assert.equal(normalizeMeshcoreNode(rawRepeater({ type: null })), null);
});

test('normalizeMeshcoreNode drops records missing a public key', () => {
  assert.equal(normalizeMeshcoreNode(rawRepeater({ public_key: '' })), null);
  assert.equal(
    normalizeMeshcoreNode(rawRepeater({ public_key: undefined })),
    null,
  );
});

test('normalizeMeshcoreNode drops records with missing or out-of-range coordinates', () => {
  assert.equal(normalizeMeshcoreNode(rawRepeater({ adv_lat: null })), null);
  assert.equal(normalizeMeshcoreNode(rawRepeater({ adv_lon: 'nope' })), null);
  assert.equal(normalizeMeshcoreNode(rawRepeater({ adv_lat: 91 })), null);
  assert.equal(normalizeMeshcoreNode(rawRepeater({ adv_lon: -181 })), null);
});

test('normalizeMeshcoreNode tolerates a missing/invalid updated_date and params', () => {
  const node = normalizeMeshcoreNode(
    rawRepeater({ updated_date: undefined, params: undefined, adv_name: '' }),
  );
  assert.equal(node.updatedAt, null);
  assert.equal(node.freq, null);
  assert.equal(node.bandwidth, null);
  assert.equal(node.name, null);
});

test('normalizeMeshcoreNode truncates an unreasonably long adv_name', () => {
  const node = normalizeMeshcoreNode(
    rawRepeater({ adv_name: 'x'.repeat(500) }),
  );
  assert.equal(node.name.length, 80);
});

test('normalizeMeshcoreNodes filters an array, silently dropping unusable records', () => {
  const nodes = normalizeMeshcoreNodes([
    rawRepeater(),
    rawRepeater({ type: 999 }),
    rawRepeater({ public_key: 'second-node', adv_lat: 47.1 }),
  ]);
  assert.equal(nodes.length, 2);
  assert.deepEqual(
    nodes.map((n) => n.id),
    [
      '0100004bc4f2fb60969e32e99c87b74185d95222145ad4d9db0d590f8f7422b1',
      'second-node',
    ],
  );
});

test('normalizeMeshcoreNodes tolerates a non-array input', () => {
  assert.deepEqual(normalizeMeshcoreNodes(null), []);
  assert.deepEqual(normalizeMeshcoreNodes(undefined), []);
});

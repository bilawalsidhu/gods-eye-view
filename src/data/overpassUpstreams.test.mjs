// Operator-supplied Overpass endpoints (OVERPASS_EXTRA_UPSTREAMS). The public
// mirrors are a shared donation-funded resource this app is not entitled to
// saturate (upstream #648), so self-hosting has to be a config change rather
// than a fork. Two behaviours carry the weight here: extras are tried FIRST,
// and an empty answer from an extra is a REFUSAL rather than data — a regional
// extract answers 200 with no elements for the whole rest of the planet, and
// caching that as truth would silently blank every Overpass-backed layer for a
// week. Pure-function tests, no network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExtraOverpassUpstreams,
  resolveOverpassUpstreams,
  isExtraOverpassUpstream,
  fetchOverpassPayload,
} from '../../vite.config.js';

test('extra upstreams accept whitespace- and comma-separated URLs, in order', () => {
  assert.deepEqual(
    parseExtraOverpassUpstreams(
      'https://a.example/api/interpreter, https://b.example/api/interpreter',
    ),
    ['https://a.example/api/interpreter', 'https://b.example/api/interpreter'],
  );
  assert.deepEqual(
    parseExtraOverpassUpstreams('https://a.example/i\n https://b.example/i'),
    ['https://a.example/i', 'https://b.example/i'],
  );
  assert.deepEqual(parseExtraOverpassUpstreams(''), []);
  assert.deepEqual(parseExtraOverpassUpstreams(undefined), []);
});

test('a private or localhost endpoint is allowed — this value is the operator, not the world', () => {
  // The SSRF refusals elsewhere guard world-editable OSM tags. This one comes
  // from the operator's own env, where a self-hosted instance is the point.
  assert.deepEqual(
    parseExtraOverpassUpstreams('http://localhost:12345/api/interpreter'),
    ['http://localhost:12345/api/interpreter'],
  );
  assert.deepEqual(parseExtraOverpassUpstreams('http://10.0.0.9/api/interpreter'), [
    'http://10.0.0.9/api/interpreter',
  ]);
});

test('unusable extra upstreams are dropped, not passed through to the fetch loop', () => {
  assert.deepEqual(
    parseExtraOverpassUpstreams(
      'not-a-url ftp://x.example/i https://u:p@x.example/i',
    ),
    [],
  );
});

test('duplicate extra upstreams collapse so one endpoint is not tried twice', () => {
  assert.deepEqual(
    parseExtraOverpassUpstreams('https://a.example/i https://a.example/i'),
    ['https://a.example/i'],
  );
});

test('extras lead the chain and are recognised as extras; built-ins still follow', () => {
  const prior = process.env.OVERPASS_EXTRA_UPSTREAMS;
  try {
    process.env.OVERPASS_EXTRA_UPSTREAMS = 'http://localhost:12345/api/interpreter';
    const chain = resolveOverpassUpstreams();
    assert.equal(chain[0], 'http://localhost:12345/api/interpreter');
    assert.ok(chain.length > 1, 'built-in mirrors remain as fallback');
    assert.ok(isExtraOverpassUpstream('http://localhost:12345/api/interpreter'));
    assert.ok(!isExtraOverpassUpstream('https://overpass-api.de/api/interpreter'));
  } finally {
    if (prior === undefined) delete process.env.OVERPASS_EXTRA_UPSTREAMS;
    else process.env.OVERPASS_EXTRA_UPSTREAMS = prior;
  }
});

test('an empty answer from an extra rotates to the next endpoint instead of being served', async () => {
  const prior = process.env.OVERPASS_EXTRA_UPSTREAMS;
  try {
    process.env.OVERPASS_EXTRA_UPSTREAMS = 'http://regional.example/api/interpreter';
    const seen = [];
    const payload = await fetchOverpassPayload('data=irrelevant', 1024, {
      endpoints: [
        'http://regional.example/api/interpreter',
        'https://planet.example/api/interpreter',
      ],
      fetchImpl: async (endpoint) => {
        seen.push(endpoint);
        return {
          status: 200,
          headers: { get: () => 'application/json' },
        };
      },
      readBody: async (_res, _cap) =>
        seen[seen.length - 1].startsWith('http://regional.example')
          ? '{"elements":[]}'
          : '{"elements":[{"type":"way","id":1}]}',
      simplify: (body) => body,
    });
    assert.deepEqual(seen, [
      'http://regional.example/api/interpreter',
      'https://planet.example/api/interpreter',
    ]);
    assert.equal(payload.endpoint, 'https://planet.example/api/interpreter');
  } finally {
    if (prior === undefined) delete process.env.OVERPASS_EXTRA_UPSTREAMS;
    else process.env.OVERPASS_EXTRA_UPSTREAMS = prior;
  }
});

test('an empty answer from a BUILT-IN mirror is still data — empty can be the truth there', async () => {
  const prior = process.env.OVERPASS_EXTRA_UPSTREAMS;
  try {
    delete process.env.OVERPASS_EXTRA_UPSTREAMS;
    const payload = await fetchOverpassPayload('data=irrelevant', 1024, {
      endpoints: ['https://overpass-api.de/api/interpreter'],
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
      }),
      readBody: async () => '{"elements":[]}',
      simplify: (body) => body,
    });
    assert.equal(payload.endpoint, 'https://overpass-api.de/api/interpreter');
    assert.equal(payload.body, '{"elements":[]}');
  } finally {
    if (prior !== undefined) process.env.OVERPASS_EXTRA_UPSTREAMS = prior;
  }
});

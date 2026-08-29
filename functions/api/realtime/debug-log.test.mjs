import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest } from './debug-log.js';

const ctx = (request) => ({ request });
const post = (body) => ctx(new Request('https://example.com/api/realtime/debug-log', {
  method: 'POST',
  body,
}));

test('non-POST methods get the dev 405 shape', async () => {
  const res = await onRequest(ctx(new Request('https://x/api/realtime/debug-log')));
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: 'Method not allowed' });
});

test('a good record is accepted with 204 and emitted as one JSON log line', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const res = await onRequest(post(JSON.stringify({ event: 'session_end', turns: 3 })));
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');

    assert.equal(lines.length, 1, 'exactly one structured line per record');
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, 'session_end');
    assert.equal(record.turns, 3);
    assert.ok(!Number.isNaN(Date.parse(record.loggedAt)), 'the sink stamps loggedAt');
  } finally {
    console.log = original;
  }
});

test('invalid JSON is rejected with the dev 400 shape', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const res = await onRequest(post('not-json'));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
    assert.equal(lines.length, 0, 'nothing is logged for a malformed record');
  } finally {
    console.log = original;
  }
});

test('oversized records are refused before parsing', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const big = JSON.stringify({ blob: 'x'.repeat(9 * 1024 * 1024) });
    const res = await onRequest(post(big));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /exceeds/);
    assert.equal(lines.length, 0);
  } finally {
    console.log = original;
  }
});

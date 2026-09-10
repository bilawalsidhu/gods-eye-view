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
    // The record is NESTED, not spread: client keys cannot collide with the
    // envelope, and `loggedAt` is always the server stamp.
    assert.equal(record.record.event, 'session_end');
    assert.equal(record.record.turns, 3);
    assert.ok(!Number.isNaN(Date.parse(record.loggedAt)), 'the sink stamps loggedAt');
  } finally {
    console.log = original;
  }
});

test('a client-supplied loggedAt cannot override the server timestamp', async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await onRequest(post(JSON.stringify({ loggedAt: '1999-01-01T00:00:00.000Z', event: 'spoof' })));
    const record = JSON.parse(lines[0]);
    assert.notEqual(record.loggedAt, '1999-01-01T00:00:00.000Z');
    assert.equal(record.record.loggedAt, '1999-01-01T00:00:00.000Z', 'the client value survives as data, never as envelope');
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

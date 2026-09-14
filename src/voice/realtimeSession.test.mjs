// realtimeSession.test.mjs — pins the SHARED debug-record redaction
// (sanitizeDebugRecord/sanitizeDebugValue + their helpers) that the voice
// client, the dev middleware, and the Pages Function all run. The endpoint
// is unauthenticated, so the server must redact without trusting the
// client's own pass — these tests pin what "redacted" means at the sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEBUG_RECORD_MAX_DEPTH,
  DEBUG_RECORD_MAX_ENTRIES,
  DEBUG_STRING_MAX_CHARS,
  isSecretLikeKey,
  sanitizeDebugRecord,
  sanitizeDebugString,
  sanitizeDebugValue,
} from './realtimeSession.js';

test('sanitizeDebugRecord: only a plain JSON object is a debug record', () => {
  const good = { event: 'session.start', turns: 3 };
  assert.deepEqual(sanitizeDebugRecord(good), good);

  assert.equal(sanitizeDebugRecord(null), null, 'null body');
  assert.equal(sanitizeDebugRecord(undefined), null, 'missing body');
  assert.equal(sanitizeDebugRecord(42), null, 'number body');
  assert.equal(sanitizeDebugRecord('event=session.start'), null, 'string body');
  assert.equal(sanitizeDebugRecord(true), null, 'boolean body');
  assert.equal(sanitizeDebugRecord(['event']), null, 'array body');
});

test('secret-like KEYS are replaced, never kept, in both walk shapes', () => {
  const hostile = {
    apiKey: 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    Authorization: 'Bearer abc.def.ghi',
    'client-secret': 'cs_live_0000000000',
    sessionToken: 'tok_0000000000',
    PASSWORD: 'hunter2',
    openai_api_key: 'sk-BBBBBBBBBBBBBBBBBBBBBBBBB',
    safe: 'kept verbatim',
    nested: { secret: 'deep', visible: 1 },
  };
  for (const sanitized of [sanitizeDebugRecord(hostile), sanitizeDebugValue(hostile)]) {
    assert.equal(sanitized.apiKey, '[Redacted]');
    assert.equal(sanitized.Authorization, '[Redacted]');
    assert.equal(sanitized['client-secret'], '[Redacted]');
    assert.equal(sanitized.sessionToken, '[Redacted]');
    assert.equal(sanitized.PASSWORD, '[Redacted]');
    assert.equal(sanitized.openai_api_key, '[Redacted]');
    assert.equal(sanitized.safe, 'kept verbatim');
    assert.equal(sanitized.nested.secret, '[Redacted]');
    assert.equal(sanitized.nested.visible, 1);
  }
  assert.deepEqual(sanitizeDebugRecord(hostile), sanitizeDebugRecord(hostile), 'pure function');
});

test('credential-shaped string VALUES are redacted even under innocent keys', () => {
  const cases = [
    ['sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', /Redacted OpenAI API key/],
    ['sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB', /Redacted OpenAI API key/],
    ['auth: Bearer c2VjcmV0LXZhbHVl', /Bearer \[Redacted\]/],
    ['{"client_secret":"ek_live_dontlogme"}', /"client_secret":"\[Redacted\]"/],
    ['{"value":"ek_1111111111aaaa"}', /Redacted ephemeral key/],
    [
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
      /Redacted JWT/,
    ],
  ];
  for (const [input, pattern] of cases) {
    assert.match(sanitizeDebugString(input), pattern, input.slice(0, 40));
    const wrapped = sanitizeDebugRecord({ note: input });
    assert.doesNotMatch(
      JSON.stringify(wrapped),
      /sk-AAA|c2VjcmV0|ek_live_dontlogme|SflKxwRJSMeK/,
      `raw secret must not survive anywhere: ${input.slice(0, 40)}`,
    );
  }
  assert.equal(sanitizeDebugString('lat 30.2672, lon -97.7431'), 'lat 30.2672, lon -97.7431');
});

test('image data URLs collapse to a size marker; long strings truncate visibly', () => {
  const dataUrl = 'data:image/png;base64,AAAA';
  assert.match(sanitizeDebugString(dataUrl), new RegExp(`Redacted image data URL, ${dataUrl.length} chars`));
  const long = 'x'.repeat(DEBUG_STRING_MAX_CHARS + 500);
  const truncated = sanitizeDebugString(long);
  assert.equal(truncated.length, DEBUG_STRING_MAX_CHARS + `...[Truncated 500 chars]`.length);
  assert.match(truncated, /\.\.\.\[Truncated 500 chars\]$/);
});

test('deep and wide hostile payloads are bounded with visible markers', () => {
  // Depth: a 40-deep chain bottoms out at the ceiling instead of recursing
  // into a RangeError inside the request handler.
  let deep = { leaf: true };
  for (let i = 0; i < 40; i += 1) deep = { next: deep };
  const redactedDeep = sanitizeDebugRecord({ payload: deep });
  let node = redactedDeep.payload;
  for (let i = 0; i < DEBUG_RECORD_MAX_DEPTH; i += 1) node = node.next;
  assert.equal(node, '[MaxDepth]');

  // Width: >500 keys/entries keep the first 500 and mark the drop.
  const wide = Object.fromEntries(
    Array.from({ length: DEBUG_RECORD_MAX_ENTRIES + 10 }, (_, i) => [`k${i}`, i]),
  );
  const redactedWide = sanitizeDebugRecord(wide);
  assert.equal(Object.keys(redactedWide).length, DEBUG_RECORD_MAX_ENTRIES + 1);
  assert.equal(redactedWide['[Truncated]'], '10 entries dropped');
  assert.equal(redactedWide.k0, 0);
  assert.equal(redactedWide.k499, 499);
  assert.equal(redactedWide.k500, undefined);

  const longArray = sanitizeDebugRecord({ list: Array.from({ length: 505 }, (_, i) => i) });
  assert.equal(longArray.list.length, DEBUG_RECORD_MAX_ENTRIES + 1);
  assert.equal(longArray.list[DEBUG_RECORD_MAX_ENTRIES], '[Truncated 5 entries]');
});

test('plain telemetry survives untouched: null, numbers, booleans, nested arrays', () => {
  const record = {
    event: 'webrtc.answer.applied',
    status: 'LISTENING',
    rttMs: 42,
    secure: true,
    nothing: null,
    path: ['a', ['b', { c: 1 }]],
  };
  assert.deepEqual(sanitizeDebugRecord(record), record);
  assert.equal(isSecretLikeKey('turnToken'), true);
  assert.equal(isSecretLikeKey('event'), false);
});

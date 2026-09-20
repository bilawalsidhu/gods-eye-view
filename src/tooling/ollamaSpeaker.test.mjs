import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  MAX_RECENT_UTTERANCES,
  SPEAKER_THRESHOLD,
  centroid,
  cosine,
  createProfileStore,
  identifySpeaker,
  matchSpeaker,
  rememberUtterance,
  runSpeakerOp,
  scoreProfiles,
  setActiveVoiceSession,
} from '../../server/providers/ollama/speaker.js';
import { createSpeakerHandler } from '../../server/providers/ollama/routes/speaker.js';

// Fake voice prints: the first byte of the "WAV" picks a speaker direction and
// the rest adds a little noise, so same-speaker cosines stay high and
// different speakers stay orthogonal without any model.
const DIRECTIONS = { A: [1, 0, 0, 0], S: [0, 1, 0, 0], X: [0, 0, 1, 0] };
function fakeEmbedding(bytes) {
  const base = DIRECTIONS[String.fromCharCode(bytes[0])] || [0, 0, 0, 1];
  const jitter = (bytes[1] || 0) / 1000;
  const v = base.map((x, i) => x + (i === 3 ? jitter : 0));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
function fakeWorker({ fail = null, speaker = true } = {}) {
  const calls = [];
  return {
    calls,
    health: () => ({ speaker }),
    async embed(wav) {
      calls.push(Buffer.from(wav));
      if (fail) throw new Error(fail);
      return { embedding: fakeEmbedding(Buffer.from(wav)), model: 'fake' };
    },
  };
}
function tempStore(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-speaker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cache', 'voice-profiles.json');
  return { store: createProfileStore({ file, now: () => 1_700_000_000_000 }), file };
}
const wav = (who, n = 0) => Buffer.from([who.charCodeAt(0), n, 0x52, 0x49]);
const session = () => ({ id: 's1', recentUtterances: [] });

test('cosine, centroid and matching behave on unit vectors', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0);
  assert.deepEqual(centroid([]), null);
  const c = centroid([
    [1, 0],
    [0, 1],
  ]);
  assert.ok(Math.abs(Math.hypot(...c) - 1) < 1e-9, 'centroid is unit length');
  const profiles = [
    { name: 'Anthony', embeddings: [fakeEmbedding(wav('A', 1)), fakeEmbedding(wav('A', 2))] },
    { name: 'Sarah', embeddings: [fakeEmbedding(wav('S', 1))] },
  ];
  const scores = scoreProfiles(fakeEmbedding(wav('A', 3)), profiles);
  assert.equal(scores[0].name, 'Anthony');
  assert.ok(scores[0].score > 0.99 && scores[1].score < 0.01);
  assert.deepEqual(matchSpeaker(fakeEmbedding(wav('A', 3)), profiles), scores[0]);
  assert.equal(matchSpeaker(fakeEmbedding(wav('X')), profiles), null, 'stranger is below threshold');
  assert.equal(matchSpeaker(fakeEmbedding(wav('A')), profiles, { threshold: 1.01 }), null);
  assert.ok(SPEAKER_THRESHOLD > 0.4 && SPEAKER_THRESHOLD < 0.9);
});

test('profile store persists to disk, matches names loosely and forgets', async (t) => {
  const { store, file } = tempStore(t);
  assert.deepEqual(await store.list(), []);
  const first = await store.enroll('  Anthony ', [[1, 0], [1, 0]], { model: 'fake' });
  assert.equal(first.name, 'Anthony');
  assert.equal(first.samples, 2);
  await store.enroll('anthony', [[0.9, 0.1]]);
  assert.equal((await store.get('ANTHONY')).embeddings.length, 3, 'same profile, case-insensitive');
  assert.ok(existsSync(file));
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.profiles[0].createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(onDisk.profiles[0].model, 'fake');
  const reloaded = createProfileStore({ file });
  assert.deepEqual((await reloaded.list()).map((p) => [p.name, p.samples]), [['Anthony', 3]]);
  assert.equal(await reloaded.forget('anthony'), true);
  assert.equal(await reloaded.forget('anthony'), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).profiles, []);
  await assert.rejects(() => store.enroll('', [[1]]), /name/);
  await assert.rejects(() => store.enroll('Bob', []), /embeddings/);
});

test('identifySpeaker remembers a bounded utterance window and only embeds once profiles exist', async (t) => {
  const { store } = tempStore(t);
  const worker = fakeWorker();
  const s = session();
  for (let i = 0; i < 5; i++)
    assert.equal(await identifySpeaker(worker, wav('A', i), s, { store }), null);
  assert.equal(s.recentUtterances.length, MAX_RECENT_UTTERANCES);
  assert.deepEqual(
    s.recentUtterances.map((u) => u.wav[1]),
    [2, 3, 4],
    'the most recent utterances are kept',
  );
  assert.equal(worker.calls.length, 0, 'no embedding round trip without profiles');

  await store.enroll('Anthony', [fakeEmbedding(wav('A', 9))]);
  const match = await identifySpeaker(worker, wav('A', 5), s, { store });
  assert.equal(match.name, 'Anthony');
  assert.ok(match.score >= SPEAKER_THRESHOLD);
  assert.deepEqual(s.lastSpeaker, match);
  assert.equal(await identifySpeaker(worker, wav('X'), s, { store }), null, 'unknown voice');
  assert.ok(s.recentUtterances.at(-1).embedding, 'embedding cached on the utterance');

  const logs = [];
  const broken = fakeWorker({ fail: 'speaker model not found' });
  assert.equal(
    await identifySpeaker(broken, wav('A'), s, { store, log: (e, p) => logs.push([e, p]) }),
    null,
    'a failed embed degrades to no speaker',
  );
  assert.deepEqual(logs, [['speaker.error', { error: 'speaker model not found' }]]);
  assert.equal(await identifySpeaker({}, wav('A'), s, { store }), null, 'a worker without embed is fine');
  assert.equal(rememberUtterance(null, wav('A')), null);
});

function request(body, method = 'POST') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: '/', headers: {} });
  return req;
}
function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setHeader = () => {};
  res.done = new Promise((resolve) => {
    res.end = (value) => resolve({ status: res.statusCode, body: JSON.parse(value) });
  });
  return res;
}
async function call(handler, body, method) {
  const res = response();
  await handler(request(body, method), res);
  return res.done;
}

test('the route enrolls from the session, identifies, lists and forgets', async (t) => {
  const { store } = tempStore(t);
  const worker = fakeWorker();
  const s = session();
  const handler = createSpeakerHandler({ getWorker: () => worker, store, getSession: () => s });

  assert.deepEqual((await call(handler, { op: 'enroll', name: 'Anthony' })), {
    status: 409,
    body: { ok: false, error: 'Nothing to enroll yet: say a sentence first, then ask again.' },
  });
  assert.deepEqual((await call(handler, { op: 'identify' })).body, {
    ok: true,
    speaker: null,
    candidates: [],
    enrolled: 0,
    hint: 'No voices are enrolled yet; offer enroll_voice.',
  });

  for (let i = 0; i < 3; i++) await identifySpeaker(worker, wav('A', i), s, { store });
  const enrolled = await call(handler, { op: 'enroll', name: 'Anthony' });
  assert.equal(enrolled.status, 200);
  assert.deepEqual(enrolled.body, { ok: true, name: 'Anthony', added: 3, samples: 3, enrolled: 1 });
  assert.equal(worker.calls.length, 3, 'each remembered utterance embedded once');
  assert.deepEqual(s.lastSpeaker, { name: 'Anthony', score: 1 });

  const listed = await call(handler, undefined, 'GET');
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.profiles[0].name, 'Anthony');
  assert.equal(listed.body.available, true);

  await identifySpeaker(worker, wav('A', 7), s, { store });
  const who = await call(handler, { op: 'identify' });
  assert.equal(who.body.speaker.name, 'Anthony');
  assert.equal(who.body.candidates.length, 1);
  assert.equal(who.body.hint, undefined);
  assert.equal(worker.calls.length, 4, 'identify reuses the cached embedding of the last utterance');

  const stranger = await call(handler, { op: 'identify', wav: wav('X').toString('base64') });
  assert.equal(stranger.body.speaker, null);
  assert.match(stranger.body.hint, /enroll_voice/);

  const uploaded = await call(handler, { op: 'enroll', name: 'Sarah', wav: wav('S').toString('base64') });
  assert.equal(uploaded.body.samples, 1);
  assert.equal(uploaded.body.enrolled, 2);

  assert.deepEqual((await call(handler, { op: 'forget', name: 'anthony' })).body, {
    ok: true,
    name: 'anthony',
    forgotten: true,
  });
  assert.equal((await call(handler, { op: 'forget', name: 'Nobody' })).body.ok, false);
  assert.deepEqual((await call(handler, { op: 'list' })).body.profiles.map((p) => p.name), ['Sarah']);
});

test('the route validates input and reports a missing speaker model as unavailable', async (t) => {
  const { store } = tempStore(t);
  const s = session();
  setActiveVoiceSession(s);
  t.after(() => setActiveVoiceSession(null));
  rememberUtterance(s, wav('A'));
  const broken = fakeWorker({ fail: 'speaker model not found: .local/models/x.onnx', speaker: false });
  const handler = createSpeakerHandler({ getWorker: () => broken, store });
  assert.equal((await call(handler, { op: 'enroll' })).status, 400);
  assert.equal((await call(handler, { op: 'forget' })).status, 400);
  assert.equal((await call(handler, { op: 'dance' })).status, 400);
  assert.equal((await call(handler, {}, 'PUT')).status, 405);
  const enroll = await call(handler, { op: 'enroll', name: 'Anthony' });
  assert.equal(enroll.status, 503);
  assert.match(enroll.body.error, /speaker model not found/);
  await store.enroll('Anthony', [[1, 0, 0, 0]]);
  assert.equal((await call(handler, { op: 'identify' })).status, 503);
  assert.equal((await call(handler, { op: 'list' })).body.available, false);
  const bad = response();
  const req = Readable.from([Buffer.from('{not json')]);
  Object.assign(req, { method: 'POST', url: '/', headers: {} });
  await handler(req, bad);
  assert.equal((await bad.done).status, 400);
  const direct = await runSpeakerOp({ op: 'identify' }, { worker: broken, store, session: null });
  assert.equal(direct.status, 409, 'no session means nothing heard');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAudioWorker, workerEnvironment } from '../../server/providers/ollama/worker.js';

// A stand-in for scripts/local_audio.py written in Node so the supervisor can
// be exercised without Python, Whisper or Piper installed.
const FAKE_WORKER = `
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
out({ type: 'ready', whisper: true, piper: true, tts: 'piper', device: 'cpu' });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n'); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.op === 'ping') out({ type: 'pong', id: req.id });
    else if (req.op === 'transcribe') out({ type: 'transcript', id: req.id, text: 'hello ' + Buffer.from(req.wav, 'base64').length, noSpeech: false });
    else if (req.op === 'tts') {
      for (let i = 0; i < 3; i++) out({ type: 'audio_chunk', id: req.id, seq: i, sampleRate: 22050, pcm16: 'AA==' });
      out({ type: 'tts_done', id: req.id, chunks: 3 });
    }
    else if (req.op === 'embed') out({ type: 'embedding', id: req.id, embedding: [1, 0, 0], dim: 3, frames: Buffer.from(req.wav, 'base64').length, model: 'fake' });
    else if (req.op === 'boom') { process.stderr.write('fatal: boom\\n'); setTimeout(() => process.exit(3), 5); }
    else if (req.op === 'slow') { /* never answers */ }
    else out({ type: 'error', id: req.id, error: 'unknown op ' + req.op });
  }
});
`;

function fakeWorkerScript(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-worker-'));
  const file = path.join(dir, 'fake_audio.mjs');
  writeFileSync(file, FAKE_WORKER);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

function make(t, extra = {}) {
  const logs = [];
  const worker = createAudioWorker({
    pythonPath: process.execPath,
    scriptPath: fakeWorkerScript(t),
    log: (event, payload) => logs.push([event, payload]),
    maxBackoffMs: 50,
    ...extra,
  });
  t.after(() => worker.dispose());
  return { worker, logs };
}

test('the supervisor correlates ids, streams chunks and reports health', async (t) => {
  const { worker, logs } = make(t);
  const health = await worker.ensureStarted();
  assert.equal(health.tts, 'piper');
  assert.equal(worker.health().starting, false);
  const [pong, transcript] = await Promise.all([
    worker.ping(),
    worker.transcribe(Buffer.from('RIFF....'), {}),
  ]);
  assert.equal(pong.type, 'pong');
  assert.equal(transcript.text, 'hello 8');
  const chunks = [];
  const done = await worker.synthesize('Hi there.', {
    onChunk: (chunk) => chunks.push(chunk.seq),
  });
  assert.deepEqual(chunks, [0, 1, 2]);
  assert.equal(done.chunks, 3);
  assert.ok(logs.some(([event]) => event === 'worker.ready'));
});

test('embed sends the WAV as base64 and returns the voice print', async (t) => {
  const { worker } = make(t);
  const reply = await worker.embed(Buffer.from('RIFFwave'));
  assert.equal(reply.type, 'embedding');
  assert.deepEqual(reply.embedding, [1, 0, 0]);
  assert.equal(reply.frames, 8, 'worker saw the decoded bytes');
  assert.equal(reply.model, 'fake');
});

test('worker errors reject only the matching request', async (t) => {
  const { worker } = make(t);
  await worker.ensureStarted();
  const [bad, good] = await Promise.allSettled([
    worker.request({ op: 'nope' }),
    worker.ping(),
  ]);
  assert.equal(bad.status, 'rejected');
  assert.match(bad.reason.message, /unknown op nope/);
  assert.equal(good.value.type, 'pong');
});

test('a request times out when the worker never answers', async (t) => {
  const { worker } = make(t);
  await worker.ensureStarted();
  await assert.rejects(
    () => worker.request({ op: 'slow' }, { timeoutMs: 40 }),
    /timed out on slow/,
  );
  assert.equal((await worker.ping()).type, 'pong');
});

test('a crash rejects pending requests with the last stderr line and respawns', async (t) => {
  const { worker, logs } = make(t);
  await worker.ensureStarted();
  const pending = worker.request({ op: 'slow' }, { timeoutMs: 5000 });
  const crash = worker.request({ op: 'boom' }, { timeoutMs: 5000 });
  const results = await Promise.allSettled([pending, crash]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /exited \(code 3/);
    assert.match(result.reason.message, /fatal: boom/);
  }
  assert.equal(worker.health().whisper, false);
  // Backoff is 1 s on the first crash; the next call waits for the respawn.
  const again = await worker.ping();
  assert.equal(again.type, 'pong');
  assert.equal(worker.health().tts, 'piper');
  assert.ok(logs.filter(([event]) => event === 'worker.spawn').length >= 2);
  assert.ok(logs.some(([event, payload]) => event === 'worker.stderr' && /boom/.test(payload.line)));
});

test('dispose stops the worker and rejects everything outstanding', async (t) => {
  const { worker } = make(t);
  await worker.ensureStarted();
  const slow = worker.request({ op: 'slow' }, { timeoutMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the write land
  worker.dispose();
  await assert.rejects(() => slow, /disposed/);
  assert.equal(worker.running, false);
  await assert.rejects(() => worker.ping(), /disposed/);
});

test('the worker environment drops provider keys, tokens and passwords but keeps its own settings', () => {
  const scrubbed = workerEnvironment({
    PATH: '/usr/bin',
    CUDA_PATH: '/opt/cuda',
    WHISPER_MODEL: 'small',
    TTS_VOICE: 'en_US-ryan-high',
    PIPER_MODEL: '/voices/ryan.onnx',
    SPEAKER_MODEL: '/models/cam.onnx',
    OPENAI_API_KEY: 'sk-secret',
    GOOGLE_MAPS_SERVER_API_KEY: 'g-secret',
    CESIUM_ION_TOKEN: 'ion-secret',
    OPENSKY_CLIENT_SECRET: 'os-secret',
    PICOVOICE_ACCESS_KEY: 'pv-secret',
    HF_TOKEN: 'hf-secret',
    DB_PASSWORD: 'pw',
    AWS_CREDENTIALS: 'x',
    UNSET: undefined,
  });
  assert.deepEqual(scrubbed, {
    PATH: '/usr/bin',
    CUDA_PATH: '/opt/cuda',
    WHISPER_MODEL: 'small',
    TTS_VOICE: 'en_US-ryan-high',
    PIPER_MODEL: '/voices/ryan.onnx',
    SPEAKER_MODEL: '/models/cam.onnx',
  });
});

test('the spawned worker never sees secret-shaped variables', async (t) => {
  let spawnedEnv = null;
  const { worker } = make(t, {
    env: { ...process.env, OPENAI_API_KEY: 'sk-leak', WHISPER_MODEL: 'tiny' },
    spawnImpl: (command, args, options) => {
      spawnedEnv = options.env;
      return spawn(command, args, options);
    },
  });
  await worker.ensureStarted();
  assert.equal(spawnedEnv.OPENAI_API_KEY, undefined);
  assert.equal(spawnedEnv.WHISPER_MODEL, 'tiny');
  assert.equal(spawnedEnv.PYTHONUNBUFFERED, '1');
});

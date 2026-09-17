import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CHUNK_BYTES,
  SAMPLE_RATE,
  createPcmChunker,
  createTranscriptRing,
  createRadioListenManager,
  ffmpegArgs,
  formatTranscript,
  publicRadioStreamUrl,
  resolveFfmpegPath,
  wavFromPcm16,
} from '../../server/providers/ollama/radio.js';
import { createRadioRouteHandler } from '../../server/providers/ollama/routes/radio.js';
import { LOCAL_TOOL_PACKS } from '../voice/tools/index.js';
import { FEATURE_ROUTES } from '../../server/providers/ollama/routes/index.js';
import {
  createHandlers,
  rankStationsByName,
  schemas,
} from '../voice/tools/radio.js';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeSpawn() {
  const spawned = [];
  const spawnImpl = (binary, args) => {
    const proc = new EventEmitter();
    proc.pid = 4000 + spawned.length;
    proc.binary = binary;
    proc.args = args;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.exitCode = 0;
      proc.emit('exit', null, 'SIGTERM');
    };
    spawned.push(proc);
    return proc;
  };
  return { spawnImpl, spawned };
}

function fakeWorker({ gate = null } = {}) {
  const calls = [];
  return {
    calls,
    async transcribe(wav, options) {
      calls.push({ wav, options });
      if (gate) await gate.promise;
      const n = calls.length;
      return {
        text: n === 2 ? '' : `slice ${n} storm warning`,
        language: 'en',
        noSpeech: n === 2,
      };
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}

async function settle(times = 10) {
  for (let i = 0; i < times; i++) await sleep(2);
}

test('wavFromPcm16 writes a 16 kHz mono 16-bit RIFF header around the samples', () => {
  const pcm = Buffer.alloc(CHUNK_BYTES, 7);
  const wav = wavFromPcm16(pcm);
  assert.equal(wav.length, 44 + CHUNK_BYTES);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + CHUNK_BYTES);
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1, 'PCM');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt32LE(28), SAMPLE_RATE * 2, 'byte rate');
  assert.equal(wav.readUInt16LE(32), 2, 'block align');
  assert.equal(wav.readUInt16LE(34), 16, 'bits');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), CHUNK_BYTES);
  assert.equal(wav[44], 7);
  assert.equal(
    wavFromPcm16(Buffer.alloc(5)).readUInt32LE(40),
    4,
    'odd tail byte dropped',
  );
});

test('the chunker emits exact 15 s slices across arbitrary pipe reads', () => {
  const chunker = createPcmChunker({ chunkBytes: 10 });
  assert.deepEqual(chunker.push(Buffer.alloc(4, 1)), []);
  assert.equal(chunker.buffered, 4);
  const first = chunker.push(Buffer.alloc(9, 2));
  assert.equal(first.length, 1);
  assert.equal(first[0].length, 10);
  assert.equal(first[0][3], 1);
  assert.equal(first[0][4], 2);
  assert.equal(chunker.buffered, 3);
  const many = chunker.push(Buffer.alloc(27, 3));
  assert.equal(many.length, 3);
  assert.ok(many.every((chunk) => chunk.length === 10));
  assert.equal(chunker.buffered, 0);
  assert.equal(chunker.flush(), null);
  chunker.push(Buffer.alloc(6, 4));
  assert.equal(chunker.flush().length, 6);
  assert.equal(chunker.buffered, 0);
  assert.equal(CHUNK_BYTES, 480_000);
});

test('the transcript ring keeps one hour, filters by minutes and searches words', () => {
  let clock = 1_000_000;
  const ring = createTranscriptRing({
    maxAgeMs: 60 * 60_000,
    now: () => clock,
  });
  ring.push({ t: clock, text: 'Traffic on I-35 is heavy', language: 'en' });
  clock += 20 * 60_000;
  ring.push({ t: clock, text: 'A storm warning for Travis County' });
  assert.equal(
    ring.push({ t: clock, text: '   ' }),
    false,
    'blank lines ignored',
  );
  clock += 20 * 60_000;
  ring.push({ t: clock, text: 'The Dodgers won again' });
  assert.equal(ring.size, 3);
  assert.deepEqual(
    ring.entries(25).map((l) => l.text),
    ['A storm warning for Travis County', 'The Dodgers won again'],
  );
  assert.equal(ring.entries().length, 3);
  assert.equal(ring.search('storm warning').length, 1);
  assert.equal(ring.search('warning storm').length, 1, 'all words match');
  assert.equal(ring.search('dodgers', 5).length, 1);
  assert.equal(ring.search('traffic', 30).length, 0, 'outside window');
  assert.equal(ring.search('').length, 0);
  clock += 25 * 60_000;
  assert.equal(ring.size, 2, 'the first line aged out past 60 minutes');
  const text = formatTranscript(ring.entries());
  assert.match(
    text,
    /^\[\d\d:\d\d:\d\d\] A storm warning for Travis County\n\[\d\d:\d\d:\d\d\] The Dodgers won again$/,
  );
});

test('stream URLs are admitted only for public http(s) hosts', () => {
  assert.equal(
    publicRadioStreamUrl('https://stream.example.com:8443/live.mp3#x'),
    'https://stream.example.com:8443/live.mp3',
  );
  assert.equal(
    publicRadioStreamUrl('http://icecast.example.org/kut'),
    'http://icecast.example.org/kut',
  );
  for (const bad of [
    'http://localhost:8000/x',
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://192.168.1.230:11434/',
    'http://169.254.169.254/latest',
    'http://[::1]/x',
    'http://printer.local/x',
    'http://host.internal/x',
    'https://user:pw@example.com/x',
    'ftp://example.com/x',
    'file:///etc/passwd',
    'not a url',
    '',
  ])
    assert.equal(publicRadioStreamUrl(bad), null, bad);
  assert.deepEqual(ffmpegArgs('https://a/b'), [
    '-nostdin',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'http,https,tcp,tls',
    '-rw_timeout',
    '15000000',
    '-i',
    'https://a/b',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    's16le',
    '-',
  ]);
});

test('ffmpeg resolves from FFMPEG_PATH, then PATH, then the winget install folder', () => {
  const winget = 'C:\\U\\AppData\\Local\\Microsoft\\WinGet\\Packages';
  const present = new Set([
    'C:\\tools\\ffmpeg.exe',
    'C:\\bin\\ffmpeg.exe',
    `${winget}\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe`,
  ]);
  const fs = {
    exists: (p) => present.has(p),
    readdir: (dir) => {
      if (dir === winget)
        return [
          'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
          'Other.Pkg',
        ];
      if (dir.endsWith('8wekyb3d8bbwe'))
        return ['ffmpeg-8.0-full_build', 'ffmpeg-9.0.1-full_build'];
      throw new Error('ENOENT');
    },
    platform: 'win32',
  };
  const base = {
    LOCALAPPDATA: 'C:\\U\\AppData\\Local',
    PATH: 'C:\\nope;C:\\bin',
  };
  assert.equal(
    resolveFfmpegPath({
      ...fs,
      env: { ...base, FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe' },
    }),
    'C:\\tools\\ffmpeg.exe',
  );
  assert.equal(
    resolveFfmpegPath({
      ...fs,
      env: { ...base, FFMPEG_PATH: 'C:\\missing.exe' },
    }),
    null,
    'an explicit path that does not exist is an error, not a silent fallback',
  );
  assert.equal(resolveFfmpegPath({ ...fs, env: base }), 'C:\\bin\\ffmpeg.exe');
  assert.equal(
    resolveFfmpegPath({ ...fs, env: { ...base, PATH: 'C:\\nope' } }),
    `${winget}\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe`,
  );
  assert.equal(
    resolveFfmpegPath({ ...fs, env: { PATH: '' }, platform: 'linux' }),
    null,
  );
});

test('a listener slices ffmpeg output, transcribes sequentially and serves transcripts', async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const worker = fakeWorker();
  let clock = 10_000_000;
  const manager = createRadioListenManager({
    worker,
    spawnImpl,
    ffmpegPath: 'ffmpeg-fake',
    lookupImpl: PUBLIC_LOOKUP,
    now: () => clock,
    chunkBytes: 1000,
  });
  const started = await manager.start({
    url: 'https://stream.example.com/live',
    label: '  KUT  Austin ',
  });
  assert.equal(started.ok, true);
  assert.equal(started.id, 'radio-1');
  assert.equal(started.label, 'KUT Austin');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, 'ffmpeg-fake');
  assert.equal(spawned[0].args.at(-1), '-');
  assert.equal(
    spawned[0].args[spawned[0].args.indexOf('-i') + 1],
    'https://stream.example.com/live',
  );

  spawned[0].stdout.write(Buffer.alloc(1500, 1));
  clock += 15_000;
  spawned[0].stdout.write(Buffer.alloc(1500, 2));
  await settle();
  assert.equal(worker.calls.length, 3);
  assert.equal(worker.calls[0].wav.length, 1044, 'chunk wrapped as WAV');
  assert.equal(worker.calls[0].wav.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(worker.calls[0].options, { language: 'auto' });

  const transcript = manager.transcript({ minutes: 5 });
  assert.equal(transcript.ok, true);
  assert.equal(transcript.id, 'radio-1');
  assert.equal(transcript.lineCount, 2, 'the noSpeech slice is skipped');
  assert.match(
    transcript.text,
    /slice 1 storm warning\n\[\d\d:\d\d:\d\d\] slice 3 storm warning$/,
  );
  assert.equal(transcript.lines[0].language, 'en');
  assert.ok(transcript.lines[0].t < transcript.lines[1].t);

  const found = manager.search({ query: 'STORM' });
  assert.equal(found.matchCount, 2);
  assert.equal(manager.search({ query: 'tornado' }).matchCount, 0);
  assert.throws(() => manager.search({ query: '' }), /query is required/);

  const status = manager.status();
  assert.equal(status.listening.length, 1);
  assert.equal(status.listening[0].chunks, 3);
  assert.equal(status.listening[0].transcribed, 3);
  assert.equal(status.listening[0].lastText, 'slice 3 storm warning');

  const again = await manager.start({ url: 'https://stream.example.com/live' });
  assert.equal(again.alreadyListening, true);
  assert.equal(spawned.length, 1, 'same URL reuses the listener');

  const stopped = manager.stop();
  assert.deepEqual(stopped.stopped, ['radio-1']);
  assert.equal(spawned[0].killed, true);
  assert.equal(manager.status().listening.length, 0);
  assert.equal(manager.status().recent[0].endedReason, 'stopped');
  assert.equal(
    manager.transcript({}).lineCount,
    2,
    'transcript outlives the stream',
  );
  assert.throws(
    () => manager.stop({ id: 'radio-9' }),
    /No radio listener radio-9/,
  );
});

test('backlog beyond two slices is dropped while one transcription is in flight', async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const gate = deferred();
  const worker = fakeWorker({ gate });
  const manager = createRadioListenManager({
    worker,
    spawnImpl,
    ffmpegPath: 'ffmpeg-fake',
    lookupImpl: PUBLIC_LOOKUP,
    chunkBytes: 100,
  });
  await manager.start({ url: 'https://stream.example.com/a' });
  spawned[0].stdout.write(Buffer.alloc(500, 1));
  await settle(3);
  assert.equal(worker.calls.length, 1, 'only one in flight');
  let status = manager.status().listening[0];
  assert.equal(status.chunks, 5);
  assert.equal(status.dropped, 2);
  gate.resolve();
  await settle();
  status = manager.status().listening[0];
  assert.equal(status.transcribed, 3);
  assert.equal(worker.calls.length, 3);
  manager.dispose();
});

test('listener limits, ffmpeg exit, time limit and host policy are enforced', async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const worker = fakeWorker();
  const manager = createRadioListenManager({
    worker,
    spawnImpl,
    ffmpegPath: 'ffmpeg-fake',
    lookupImpl: PUBLIC_LOOKUP,
    // Larger than the 32 050-byte write below so the whole write is the tail.
    chunkBytes: 100_000,
    maxListenMs: 30,
  });
  await assert.rejects(
    manager.start({ url: 'http://127.0.0.1:8000/x' }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /public http\(s\)/);
      return true;
    },
  );
  const privateDns = createRadioListenManager({
    worker,
    spawnImpl,
    ffmpegPath: 'ffmpeg-fake',
    lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }],
  });
  await assert.rejects(
    privateDns.start({ url: 'https://evil.example.com/x' }),
    /forbidden address/,
  );
  assert.equal(spawned.length, 0, 'nothing spawned for rejected hosts');

  const missing = createRadioListenManager({
    worker,
    spawnImpl: fakeSpawn().spawnImpl,
    ffmpegPath: () => null,
    lookupImpl: PUBLIC_LOOKUP,
  });
  await assert.rejects(
    missing.start({ url: 'https://stream.example.com/x' }),
    (error) => {
      assert.equal(error.status, 501);
      assert.match(error.message, /FFMPEG_PATH/);
      return true;
    },
  );
  assert.equal(missing.status().ffmpeg, false);

  await manager.start({ url: 'https://stream.example.com/a' });
  await manager.start({ url: 'https://stream.example.com/b' });
  await assert.rejects(
    manager.start({ url: 'https://stream.example.com/c' }),
    (error) => {
      assert.equal(error.status, 409);
      return true;
    },
  );

  spawned[0].stdout.write(Buffer.alloc(32_050, 1));
  spawned[0].stderr.write('https: connection reset\n');
  spawned[0].exitCode = 1;
  spawned[0].emit('exit', 1, null);
  await settle();
  const recent = manager.status().recent.find((l) => l.id === 'radio-1');
  assert.match(
    recent.endedReason,
    /ffmpeg exited \(code 1, signal null\): https: connection reset/,
  );
  assert.equal(
    recent.transcribed,
    1,
    'the partial tail (>= 1 s) is still transcribed',
  );

  await sleep(60);
  const timed = manager.status().recent.find((l) => l.id === 'radio-2');
  assert.equal(timed.endedReason, 'time limit');
  assert.equal(spawned[1].killed, true);
  assert.equal(manager.status().listening.length, 0);
  const third = await manager.start({ url: 'https://stream.example.com/c' });
  assert.equal(third.id, 'radio-3', 'ended listeners free their slot');
  manager.dispose();
  assert.equal(spawned[2].killed, true);
});

function fakeRequest(method, body) {
  const req = new PassThrough();
  req.method = method;
  req.url = '/';
  if (body !== undefined) req.end(JSON.stringify(body));
  else req.end();
  return req;
}

function fakeResponse() {
  const res = {
    status: null,
    headers: null,
    body: '',
    done: deferred(),
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(chunk) {
      res.body = chunk ? String(chunk) : '';
      res.done.resolve();
    },
  };
  return res;
}

async function call(handler, method, body) {
  const res = fakeResponse();
  await handler(fakeRequest(method, body), res);
  await res.done.promise;
  return {
    status: res.status,
    json: res.body ? JSON.parse(res.body) : null,
    headers: res.headers,
  };
}

test('the /api/voice/radio route dispatches ops and maps errors to statuses', async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const worker = fakeWorker();
  const manager = createRadioListenManager({
    worker,
    spawnImpl,
    ffmpegPath: 'ffmpeg-fake',
    lookupImpl: PUBLIC_LOOKUP,
    chunkBytes: 100,
  });
  const handler = createRadioRouteHandler({ getManager: () => manager });

  assert.equal((await call(handler, 'PUT', {})).status, 405);
  const badJson = fakeResponse();
  const raw = new PassThrough();
  raw.method = 'POST';
  raw.end('{nope');
  await handler(raw, badJson);
  assert.equal(badJson.status, 400);
  assert.match(JSON.parse(badJson.body).error, /Invalid JSON/);
  const unknown = await call(handler, 'POST', { op: 'reboot' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /Unknown op "reboot"/);

  const empty = await call(handler, 'POST', { op: 'transcript' });
  assert.equal(empty.status, 404);
  assert.match(empty.json.error, /radio_listen first/);

  const bad = await call(handler, 'POST', {
    op: 'start',
    url: 'http://localhost/x',
  });
  assert.equal(bad.status, 400);

  const started = await call(handler, 'POST', {
    op: 'start',
    url: 'https://stream.example.com/x',
    label: 'BBC',
  });
  assert.equal(started.status, 200);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.label, 'BBC');
  assert.equal(
    started.headers['Content-Type'],
    'application/json; charset=utf-8',
  );

  spawned[0].stdout.write(Buffer.alloc(100, 1));
  await settle();
  const transcript = await call(handler, 'POST', {
    op: 'transcript',
    minutes: 5,
  });
  assert.equal(transcript.json.lineCount, 1);
  assert.match(transcript.json.text, /slice 1 storm warning/);
  const search = await call(handler, 'POST', { op: 'search', query: 'storm' });
  assert.equal(search.json.matchCount, 1);
  const status = await call(handler, 'GET');
  assert.equal(status.json.listening.length, 1);
  const stopped = await call(handler, 'POST', { op: 'stop' });
  assert.deepEqual(stopped.json.stopped, ['radio-1']);

  const broken = createRadioRouteHandler({
    getManager: () => {
      throw new Error('worker offline');
    },
  });
  const down = await call(broken, 'POST', { op: 'status' });
  assert.equal(down.status, 503);
});

test('the pack and route are registered and every tool has a handler', () => {
  assert.ok(LOCAL_TOOL_PACKS.some((pack) => pack.schemas === schemas));
  assert.equal(FEATURE_ROUTES.length >= 1, true);
  const handlers = createHandlers({
    getGlobe: () => null,
    fetchJson: async () => ({}),
  });
  for (const tool of schemas) {
    assert.equal(typeof handlers[tool.name], 'function', tool.name);
    assert.equal(tool.parameters.additionalProperties, false);
  }
  assert.deepEqual(
    schemas.map((tool) => tool.name),
    ['radio_listen', 'radio_stop', 'radio_transcript', 'radio_search'],
  );
  assert.match(
    schemas.find((t) => t.name === 'radio_listen').description,
    /radio_transcript/,
  );
});

const STATIONS = [
  {
    id: 'a',
    name: 'BBC Radio 2',
    streamUrl: 'https://bbc.example/r2',
    tags: ['pop'],
    country: 'UK',
  },
  {
    id: 'b',
    name: 'BBC World Service',
    streamUrl: 'https://bbc.example/ws',
    tags: ['news'],
    country: 'UK',
  },
  {
    id: 'c',
    name: 'KUT 90.5',
    streamUrl: 'https://kut.example/live',
    tags: ['npr', 'news'],
    state: 'Texas',
    country: 'USA',
  },
  { id: 'd', name: 'No Stream FM', streamUrl: null, tags: ['news'] },
];

test('station names rank exact, prefix and contains matches ahead of tag hits', () => {
  assert.deepEqual(
    rankStationsByName(STATIONS, 'bbc world service').map((s) => s.id),
    ['b'],
  );
  assert.deepEqual(
    rankStationsByName(STATIONS, 'BBC').map((s) => s.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    rankStationsByName(STATIONS, 'world service').map((s) => s.id),
    ['b'],
  );
  assert.deepEqual(
    rankStationsByName(STATIONS, 'news').map((s) => s.id),
    ['b', 'c'],
    'tag hits, no stream skipped',
  );
  assert.deepEqual(
    rankStationsByName(STATIONS, 'texas').map((s) => s.id),
    ['c'],
  );
  assert.deepEqual(rankStationsByName(STATIONS, ''), []);
});

test('radio_listen resolves the playing station, else searches the directory, then calls the route', async () => {
  const posts = [];
  const fetchJson = async (url, body) => {
    posts.push({ url, body });
    if (url === '/api/radio/stations') return { stations: STATIONS };
    if (body.op === 'start')
      return { ok: true, id: 'radio-1', label: body.label };
    if (body.op === 'transcript')
      return {
        ok: true,
        label: 'KUT 90.5',
        active: true,
        minutes: 5,
        lineCount: 2,
        text: '[a] x\n[b] y',
      };
    if (body.op === 'search')
      return {
        ok: true,
        label: 'KUT 90.5',
        query: body.query,
        minutes: 30,
        matchCount: 0,
        text: '',
      };
    if (body.op === 'stop')
      return { ok: true, stopped: ['radio-1'], listening: [] };
    return {};
  };
  let ui = {
    audioState: 'playing',
    playingStationId: 'c',
    selected: STATIONS[2],
  };
  const radioModule = {
    getRadioUIState: () => ui,
    getRadioAcceptedCatalogSnapshot: () => ({ stations: STATIONS }),
    rankRadioStationsForRequest: (stations, { stationQuery }) =>
      stations.filter((s) =>
        s.name.toLowerCase().includes(stationQuery.toLowerCase()),
      ),
  };
  const globe = {
    dataManager: {
      layers: {
        get: (id) => (id === 'radio' ? { module: radioModule } : undefined),
      },
    },
  };
  const tools = createHandlers({ getGlobe: () => globe, fetchJson });

  const current = await tools.radio_listen({});
  assert.equal(current.ok, true);
  assert.equal(current.listening, 'KUT 90.5');
  assert.equal(current.playingInRadioLayer, true);
  assert.equal(current.resolvedBy, 'playing in the Radio layer');
  assert.deepEqual(posts.at(-1).body, {
    op: 'start',
    url: 'https://kut.example/live',
    label: 'KUT 90.5',
  });

  // Playing id differs from the selection: the catalog resolves it.
  ui = { audioState: 'playing', playingStationId: 'b', selected: STATIONS[0] };
  assert.equal((await tools.radio_listen({})).listening, 'BBC World Service');

  // Selected but stopped: fall back to the selection and say so.
  ui = { audioState: 'stopped', playingStationId: null, selected: STATIONS[0] };
  const selected = await tools.radio_listen({});
  assert.equal(selected.listening, 'BBC Radio 2');
  assert.equal(selected.playingInRadioLayer, false);

  ui = { audioState: 'stopped', playingStationId: null, selected: null };
  const none = await tools.radio_listen({});
  assert.equal(none.ok, false);
  assert.match(none.error, /No station is playing/);

  const byName = await tools.radio_listen({ station: 'bbc world' });
  assert.equal(byName.listening, 'BBC World Service');
  assert.match(byName.resolvedBy, /radio directory/);
  const miss = await tools.radio_listen({ station: 'zzz' });
  assert.equal(miss.ok, false);

  // Without the layer the directory endpoint is used.
  const bare = createHandlers({ getGlobe: () => null, fetchJson });
  const viaDirectory = await bare.radio_listen({ station: 'KUT' });
  assert.equal(viaDirectory.listening, 'KUT 90.5');
  assert.ok(posts.some((p) => p.url === '/api/radio/stations'));
  assert.match((await bare.radio_listen({})).error, /No station is playing/);

  const transcript = await tools.radio_transcript({ minutes: 5 });
  assert.equal(transcript.lineCount, 2);
  assert.equal(transcript.text, '[a] x\n[b] y');
  assert.deepEqual(posts.at(-1).body, { op: 'transcript', minutes: 5 });
  const search = await tools.radio_search({ query: 'highway' });
  assert.equal(search.matchCount, 0);
  assert.match(search.note, /not mentioned/);
  assert.deepEqual(posts.at(-1).body, {
    op: 'search',
    query: 'highway',
    minutes: 30,
  });
  assert.equal((await tools.radio_search({})).ok, false);
  const stopped = await tools.radio_stop();
  assert.deepEqual(stopped.stopped, ['radio-1']);
});

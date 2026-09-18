import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTransport,
  createSseParser,
  createAnswerAccumulator,
  normalizeMapActions,
  parseNodeValue,
  readStoredKey,
  keyHeaders,
  voiceUserId,
  TransportError,
  KEY_HEADER,
  AUDIO_AGENT_PLUGIN_ID,
  PATHS,
} from './transport.js';

const SECRET = 'od-secret-key-XYZ';

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sse(frames) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

/** Sequence of canned responses; records {url, method, headers, body}. */
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: init.body,
      signal: init.signal,
    };
    calls.push(call);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === 'function' ? next(call) : next;
  };
  fn.calls = calls;
  return fn;
}

function immediateTimers() {
  const delays = [];
  return {
    delays,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      queueMicrotask(fn);
      return delays.length;
    },
    clearTimeout: () => {},
  };
}

test('readStoredKey / keyHeaders: header only when a key is stored (trimmed), never otherwise', () => {
  assert.equal(readStoredKey(memoryStorage({ 'ondemand.apiKey': `  ${SECRET} ` })), SECRET);
  assert.equal(readStoredKey(memoryStorage()), '');
  assert.equal(readStoredKey(null), '');
  assert.equal(
    readStoredKey({
      getItem() {
        throw new Error('blocked');
      },
    }),
    '',
  );
  assert.deepEqual(keyHeaders(SECRET), { [KEY_HEADER]: SECRET });
  assert.deepEqual(keyHeaders(''), {});
  assert.equal(KEY_HEADER, 'x-ondemand-key');
});

test('voiceUserId is the per-day id the spec names', () => {
  assert.equal(voiceUserId(() => Date.UTC(2026, 8, 18, 12)), 'ondemand-spatial-voice-2026-09-18');
});

test('STT request shape: multipart media upload {file,name,sessionId,plugins,sizeBytes,responseMode} then JSON {audioUrl}; key header on both', async () => {
  const fetch = fakeFetch([
    json(201, { message: 'Media Created', data: { id: 'file-1', url: 'https://cdn.example/utt.webm' } }),
    json(200, { message: 'ok', data: { text: '  show military flights near me ' } }),
  ]);
  const transport = createTransport({
    fetch,
    storage: memoryStorage({ 'ondemand.apiKey': SECRET }),
    now: () => 1000,
  });
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
  const result = await transport.transcribe(blob, { sessionId: 'sess-1' });
  assert.equal(result.text, 'show military flights near me');
  assert.equal(result.audioUrl, 'https://cdn.example/utt.webm');

  const [upload, stt] = fetch.calls;
  assert.equal(upload.url, PATHS.media);
  assert.equal(upload.method, 'POST');
  assert.ok(upload.body instanceof FormData);
  assert.equal(upload.headers['Content-Type'], undefined, 'browser sets the multipart boundary');
  assert.equal(upload.headers[KEY_HEADER], SECRET);
  const file = upload.body.get('file');
  assert.ok(file && typeof file.arrayBuffer === 'function');
  assert.equal(file.size, 4);
  assert.equal(upload.body.get('name'), 'utterance.webm');
  assert.equal(upload.body.get('sessionId'), 'sess-1');
  assert.equal(upload.body.get('plugins'), AUDIO_AGENT_PLUGIN_ID);
  assert.equal(upload.body.get('sizeBytes'), '4');
  assert.equal(upload.body.get('responseMode'), 'sync');

  assert.equal(stt.url, PATHS.stt);
  assert.equal(stt.method, 'POST');
  assert.equal(stt.headers['Content-Type'], 'application/json');
  assert.equal(stt.headers[KEY_HEADER], SECRET);
  assert.deepEqual(JSON.parse(stt.body), { audioUrl: 'https://cdn.example/utt.webm' });
});

test('no stored key → no x-ondemand-key header on any call', async () => {
  const fetch = fakeFetch([json(201, { sessionId: 's', reused: false })]);
  const transport = createTransport({ fetch, storage: memoryStorage() });
  await transport.createSession({ userId: 'u' });
  assert.equal(fetch.calls[0].headers[KEY_HEADER], undefined);
  assert.equal(transport.hasKey(), false);
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { userId: 'u' });
});

test('session + chat stream: POST {sessionId, query, responseMode:"stream"}; fulfillment deltas accumulate, statusLog/metrics/heartbeat/thinking ignored, [DONE] ends', async () => {
  const frames = [
    'event:heartbeat\ndata:{"sessionId":"s1","messageId":"m1","time":"t"}\n\n',
    'event:message\ndata:{"sessionId":"s1","messageId":"m1","eventIndex":1,"eventType":"statusLog","status":"processing","currentStatusLog":{"statusType":"fulfilling","statusMessage":"Fulfilling"}}\n\n',
    'event:message\ndata:{"sessionId":"s1","messageId":"m1","eventIndex":1,"eventType":"fulfillment_thinking","answer":"hmm"}\n\n',
    'event:message\ndata:{"sessionId":"s1","messageId":"m1","answer":"Two","status":"processing","eventIndex":2,"eventType":"fulfillment"}\n\n',
    // out-of-order chunk: index 4 arrives before 3, re-ordered by eventIndex
    'event:message\ndata:{"sessionId":"s1","messageId":"m1","answer":" tracks.","status":"processing","eventIndex":4,"eventType":"fulfillment"}\n\nevent:message\ndata:{"sessionId":"s1","messageId":"m1","answer":" military","status":"processing","eventIndex":3,"eventType":"fulfillment"}\n\n',
    'event:message\ndata:{"sessionId":"s1","messageId":"m1","eventIndex":5,"eventType":"metricsLog","publicMetrics":{"totalTimeSec":1.2}}\n\n',
    'event:message\ndata:[DONE]\n\n',
  ];
  const fetch = fakeFetch([json(201, { sessionId: 'sess-9', reused: false }), sse(frames)]);
  const transport = createTransport({ fetch, storage: memoryStorage({ 'ondemand.apiKey': SECRET }) });
  const session = await transport.createSession({ userId: 'ondemand-spatial-voice-2026-09-18' });
  assert.equal(session.sessionId, 'sess-9');
  const deltas = [];
  const statuses = [];
  const answer = await transport.chatStream({
    sessionId: session.sessionId,
    query: 'what is overhead?',
    onDelta: (text, delta) => deltas.push([text, delta]),
    onStatus: (log) => statuses.push(log.statusType),
  });
  assert.equal(answer.text, 'Two military tracks.');
  assert.equal(answer.messageId, 'm1');
  assert.equal(answer.streamed, true);
  assert.deepEqual(answer.metrics, { totalTimeSec: 1.2 });
  assert.deepEqual(answer.statusLogs.map((s) => s.statusType), ['fulfilling']);
  assert.deepEqual(statuses, ['fulfilling']);
  assert.deepEqual(deltas.map((d) => d[1]), ['Two', ' tracks.', ' military']);
  assert.equal(deltas[deltas.length - 1][0], 'Two military tracks.');

  const [sessions, chat] = fetch.calls;
  assert.equal(sessions.url, PATHS.sessions);
  assert.deepEqual(JSON.parse(sessions.body), { userId: 'ondemand-spatial-voice-2026-09-18' });
  assert.equal(chat.url, PATHS.chat);
  assert.equal(chat.method, 'POST');
  assert.equal(chat.headers.Accept, 'text/event-stream');
  assert.equal(chat.headers[KEY_HEADER], SECRET);
  assert.deepEqual(JSON.parse(chat.body), {
    sessionId: 'sess-9',
    query: 'what is overhead?',
    responseMode: 'stream',
  });
});

test('chat stream [ERROR]: frame throws a TransportError with the upstream message', async () => {
  const fetch = fakeFetch([
    sse(['event:message\ndata:[ERROR]:{"message":"Model context length exceeded","errorCode":"context_length_exceeded"}\n\n']),
  ]);
  const transport = createTransport({ fetch });
  await assert.rejects(
    transport.chatStream({ sessionId: 's', query: 'q' }),
    (error) => error instanceof TransportError && /context length exceeded/.test(error.message),
  );
});

test('proxy errors map to TransportError with status/code; 501/503/404 are "unavailable"', async () => {
  const fetch = fakeFetch([
    json(503, { error: 'not_configured', message: 'ONDEMAND_API_KEY is not set on the server.' }),
    json(501, { error: 'not_documented', feature: 'stt raw-audio upload' }),
    json(400, { error: 'endpointId_required', message: 'No endpointId…' }),
  ]);
  const transport = createTransport({ fetch });
  await assert.rejects(transport.createSession({ userId: 'u' }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'not_configured');
    assert.equal(error.unavailable, true);
    assert.match(error.message, /not configured/);
    return true;
  });
  await assert.rejects(transport.createSession({ userId: 'u' }), (error) => {
    assert.equal(error.status, 501);
    assert.equal(error.unavailable, true);
    return true;
  });
  await assert.rejects(transport.createSession({ userId: 'u' }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'endpointId_required');
    assert.equal(error.unavailable, false);
    return true;
  });
  const offline = createTransport({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(offline.createSession({ userId: 'u' }), (error) => {
    assert.equal(error.status, 0);
    assert.equal(error.code, 'network');
    return true;
  });
});

test('TTS request shape: POST /api/ondemand/tts?format=audio {input, voice}; audio bytes → Blob (octet-stream re-typed as audio/mpeg); JSON envelope → hosted url', async () => {
  const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const fetch = fakeFetch([
    new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    json(200, { message: 'ok', data: { audioUrl: 'https://cdn.example/answer.mp3' } }),
  ]);
  const transport = createTransport({ fetch, storage: memoryStorage({ 'ondemand.apiKey': SECRET }) });
  const spoken = await transport.synthesize('Military flights layer on.');
  assert.equal(spoken.kind, 'blob');
  assert.equal(spoken.blob.type, 'audio/mpeg');
  assert.equal(spoken.bytes, 4);
  const call = fetch.calls[0];
  assert.equal(call.url, `${PATHS.tts}?format=audio`);
  assert.equal(call.method, 'POST');
  assert.match(call.headers.Accept, /^audio\/mpeg/);
  assert.equal(call.headers[KEY_HEADER], SECRET);
  assert.deepEqual(JSON.parse(call.body), { input: 'Military flights layer on.', voice: 'alloy' });

  const hosted = await transport.synthesize('again', { voice: 'nova' });
  assert.deepEqual({ kind: hosted.kind, url: hosted.url }, { kind: 'url', url: 'https://cdn.example/answer.mp3' });
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { input: 'again', voice: 'nova' });
  await assert.rejects(transport.synthesize(''), /nothing to speak/);
});

test('workflow: execute is input-less (POST /api/ondemand/workflow/execute {}), poll status+logs with 1 s → 3 s backoff, timeToFirstLog, outputs → StructuredResponse actions', async () => {
  let clock = 0;
  const timers = immediateTimers();
  const structured = {
    message: 'One anomalous military track verified north of the airport.',
    entities: [],
    actions: [
      { name: 'set_layer_visibility', params: { layerId: 'military', enabled: true }, reason: 'needed' },
      { name: 'not_a_real_action', params: {} },
      { name: 'track_entity', params: { query: 'RCH421' } },
    ],
    evidence: [],
    sources: [],
    suggestedNextActions: [],
    runMeta: { flowVersion: 1 },
  };
  const fetch = fakeFetch([
    (call) => {
      clock += 300;
      return json(200, { executionID: 'exec-42' });
    },
    // poll 1: executing, no logs yet
    () => json(200, { data: { status: 'executing' } }),
    () => json(200, { data: [] }),
    // poll 2: executing, first logs
    () => {
      clock += 100;
      return json(200, { data: { status: 'executing' } });
    },
    () =>
      json(200, {
        data: [{ timestamp: 1, nodeKey: 'session_context', message: 'started' }],
      }),
    // poll 3: success
    () => json(200, { data: { status: 'success', endedAtInMilliseconds: 99 } }),
    () =>
      json(200, {
        data: [
          { timestamp: 1, nodeKey: 'session_context', message: 'started' },
          { timestamp: 2, nodeKey: 'structured_response', message: 'done' },
        ],
      }),
    () => json(200, { data: { outputs: { structured_response: { value: '```json\n' + JSON.stringify(structured) + '\n```' } } } }),
  ]);
  const transport = createTransport({
    fetch,
    now: () => clock,
    setTimeout: (fn, ms) => {
      clock += ms;
      return timers.setTimeout(fn, ms);
    },
    clearTimeout: timers.clearTimeout,
  });
  const logs = [];
  const statuses = [];
  const result = await transport.runWorkflow({
    onLog: (row) => logs.push(row.nodeKey),
    onStatus: (s) => statuses.push(s.status),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'success');
  assert.equal(result.executionId, 'exec-42');
  assert.equal(result.executeMs, 300);
  // execute 300 ms + poll1 (no logs) + 1000 ms delay + 100 ms → first log seen at 1400 ms
  assert.equal(result.timeToFirstLogMs, 1400);
  assert.deepEqual(timers.delays, [1000, 1500]);
  assert.equal(result.polls, 3);
  assert.deepEqual(logs, ['session_context', 'structured_response']);
  assert.deepEqual(statuses, ['executing', 'executing', 'success']);
  assert.equal(result.message, structured.message);
  assert.deepEqual(result.mapActions, [
    { name: 'set_layer_visibility', args: { layerId: 'military', enabled: true }, reason: 'needed' },
    { name: 'track_entity', args: { query: 'RCH421' } },
  ]);
  assert.deepEqual(result.nodeKeys, ['structured_response']);

  const urls = fetch.calls.map((c) => `${c.method} ${c.url}`);
  assert.equal(urls[0], `POST ${PATHS.workflowExecute}`);
  assert.deepEqual(JSON.parse(fetch.calls[0].body), {});
  assert.equal(urls[1], `GET ${PATHS.workflow}/status?executionId=exec-42`);
  assert.equal(urls[2], `GET ${PATHS.workflow}/logs?executionId=exec-42`);
  assert.equal(urls[7], `GET ${PATHS.workflow}/outputs?executionId=exec-42`);
});

test('workflow poll: budget exhausted → status "timeout" (no outputs read); abort → AbortError; poll backoff caps at 3 s', async () => {
  let clock = 0;
  const delays = [];
  const fetch = fakeFetch([
    json(200, { executionID: 'exec-slow' }),
    () => json(200, { data: { status: 'executing' } }),
    () => json(200, { data: [] }),
  ]);
  const transport = createTransport({
    fetch,
    now: () => clock,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      clock += ms;
      queueMicrotask(fn);
      return 1;
    },
    clearTimeout: () => {},
  });
  const result = await transport.runWorkflow({ timeoutMs: 12_000 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.ok, false);
  assert.equal(result.timeToFirstLogMs, null);
  assert.deepEqual(delays, [1000, 1500, 2250, 3000, 3000]);
  assert.ok(!fetch.calls.some((c) => c.url.includes('/outputs')));

  const controller = new AbortController();
  const aborting = createTransport({
    fetch: fakeFetch([
      json(200, { executionID: 'exec-abort' }),
      () => {
        controller.abort();
        return json(200, { data: { status: 'executing' } });
      },
      () => json(200, { data: [] }),
    ]),
    now: () => 0,
    setTimeout: (fn) => queueMicrotask(fn),
    clearTimeout: () => {},
  });
  await assert.rejects(aborting.runWorkflow({ signal: controller.signal }), (error) => error.name === 'AbortError');
});

test('createSseParser handles split chunks, CRLF, comments and multi-line data', () => {
  const parser = createSseParser();
  const out = [
    ...parser.push('event: message\r\ndata: {"a":'),
    ...parser.push('1}\r\n\r\n: keepalive\n\ndata: l1\ndata: l2\n\n'),
    ...parser.end(),
  ];
  assert.deepEqual(out, [
    { event: 'message', data: '{"a":1}' },
    { event: 'message', data: 'l1\nl2' },
  ]);
});

test('createAnswerAccumulator orders deltas by eventIndex and exposes done', () => {
  const acc = createAnswerAccumulator();
  acc.consume({ event: 'message', data: '{"eventType":"fulfillment","eventIndex":2,"answer":"B"}' });
  acc.consume({ event: 'message', data: '{"eventType":"fulfillment","eventIndex":1,"answer":"A"}' });
  assert.equal(acc.done, false);
  acc.consume({ event: 'message', data: '[DONE]' });
  assert.equal(acc.text, 'AB');
  assert.equal(acc.done, true);
});

test('normalizeMapActions / parseNodeValue', () => {
  assert.deepEqual(
    normalizeMapActions([
      { name: 'fly_to_location', args: { latitude: 1 } },
      { name: 'zoom_to_globe', params: {} },
      { name: 'nope' },
      null,
      { name: 'set_hud' },
    ]),
    [
      { name: 'fly_to_location', args: { latitude: 1 } },
      { name: 'zoom_to_globe', args: {} },
      { name: 'set_hud', args: {} },
    ],
  );
  assert.deepEqual(normalizeMapActions('x'), []);
  assert.deepEqual(parseNodeValue('{"a":1}'), { a: 1 });
  assert.deepEqual(parseNodeValue('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseNodeValue('prefix {"a":1} suffix'), { a: 1 });
  assert.equal(parseNodeValue('nope'), null);
  assert.deepEqual(parseNodeValue({ a: 2 }), { a: 2 });
});

test('tools catalogue is cached and never throws; a missing route yields []', async () => {
  const fetch = fakeFetch([json(200, { tools: [{ id: 'earthquake_search', name: 'Quakes', tools: [] }] })]);
  const transport = createTransport({ fetch, now: () => 0 });
  assert.equal((await transport.tools())[0].id, 'earthquake_search');
  await transport.tools();
  assert.equal(fetch.calls.length, 1);
  const missing = createTransport({ fetch: fakeFetch([json(404, { error: 'Unknown API route' })]) });
  assert.deepEqual(await missing.tools(), []);
});

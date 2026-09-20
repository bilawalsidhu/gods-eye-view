import assert from 'node:assert/strict';
import test from 'node:test';
import { createSentenceSplitter } from '../../server/providers/ollama/sentences.js';
import { trimHistory } from '../../server/providers/ollama/history.js';
import { deterministicFlyTo } from '../../server/providers/ollama/fastPath.js';
import {
  runTurn,
  createSpeechQueue,
  MAX_TOOL_ROUNDS,
} from '../../server/providers/ollama/voice.js';
import { ndjson } from '../../server/providers/ollama/chat.js';

test('sentence splitter emits speakable sentences as tokens stream in', () => {
  const splitter = createSentenceSplitter({ minChars: 10 });
  const out = [];
  for (const delta of [
    'Flying to ',
    'Tokyo now. The ',
    'flights layer is on! Vers',
    'ion 3.5 is out. e.g. this stays. ',
    'Done',
  ])
    out.push(...splitter.push(delta));
  out.push(...splitter.flush());
  assert.deepEqual(out, [
    'Flying to Tokyo now.',
    'The flights layer is on!',
    'Version 3.5 is out.',
    'e.g. this stays.',
    'Done',
  ]);
  const long = createSentenceSplitter({ minChars: 10, maxChars: 40 });
  const words = long.push('word '.repeat(20));
  assert.ok(words.length >= 2);
  assert.ok(words.every((sentence) => sentence.length <= 40));
  assert.deepEqual(createSentenceSplitter().push(''), []);
  assert.deepEqual(createSentenceSplitter().flush(), []);
});

test('history budget keeps the system prompt, recent turns and no orphan tool results', () => {
  const system = { role: 'system', content: 'S' };
  const messages = [system];
  for (let turn = 0; turn < 10; turn++) {
    messages.push({ role: 'user', content: `u${turn}` });
    messages.push({
      role: 'assistant',
      tool_calls: [{ function: { name: 'set_layer_visibility' } }],
    });
    messages.push({ role: 'tool', name: 'x', content: 'r'.repeat(2000) });
    messages.push({ role: 'assistant', content: `a${turn}` });
  }
  const trimmed = trimHistory(messages, { maxTurns: 4, maxToolResultChars: 50 });
  assert.equal(trimmed[0], system);
  const users = trimmed.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(users, ['u6', 'u7', 'u8', 'u9']);
  trimmed.forEach((message, index) => {
    if (message.role === 'tool') {
      assert.ok(Array.isArray(trimmed[index - 1].tool_calls), 'tool follows its call');
      assert.ok(message.content.length <= 50);
    }
  });
  const toolTurns = trimmed.filter((m) => m.role === 'tool').length;
  assert.equal(toolTurns, 2, 'only the two most recent turns keep tool exchanges');
  assert.deepEqual(trimHistory([]), []);
  assert.deepEqual(trimHistory([system]), [system]);
});

test('deterministic fly-to only fires for bare preset destinations', () => {
  const ids = ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'];
  for (const [text, expected] of [
    ['Fly to Paris.', 'paris'],
    ['fly to paris', 'paris'],
    ['Take me to New York City', 'nyc'],
    ['please go to San Francisco', 'sf'],
    ['Navigate to Washington D.C.', 'dc'],
    ['Go to the city of Tokyo, please', 'tokyo'],
  ]) {
    assert.deepEqual(
      deterministicFlyTo(text, { locationIds: ids }),
      { name: 'fly_to_location', arguments: { locationId: expected } },
      text,
    );
  }
  for (const text of [
    'Fly to the biggest fire',
    'What is Paris',
    'Go to the flights layer',
    'Fly to Paris and turn on flights',
    'Fly to Berlin',
    'Zoom out to the globe',
    '',
  ])
    assert.equal(deterministicFlyTo(text, { locationIds: ids }), null, text);
});

test('ndjson parses chunked newline-delimited JSON streams', async () => {
  const chunks = ['{"a":1}\n{"b"', ':2}\n', '{"c":3}'];
  const body = (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
  const seen = [];
  for await (const item of ndjson(body)) seen.push(item);
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

function session() {
  return {
    id: 's',
    messages: [{ role: 'system', content: 'S' }],
    pending: new Map(),
    turnAbort: null,
    closeSignal: new AbortController().signal,
  };
}

function fakeWorker({ tts = 'piper' } = {}) {
  return {
    health: () => ({ tts }),
    synthesize: async (text, { onChunk }) => {
      onChunk({ sampleRate: 22050, pcm16: Buffer.from(text).toString('base64') });
      return { chunks: 1 };
    },
  };
}

test('a model turn streams sentences to speech, runs tools and ends with text + audio_end', async () => {
  const s = session();
  const sent = [];
  let round = 0;
  const send = (frame) => {
    sent.push(frame);
    if (frame.type === 'tool_call')
      setTimeout(() => s.pending.get(frame.callId)?.({ ok: true, did: frame.name }), 0);
  };
  const chat = async ({ messages, onToken }) => {
    round++;
    if (round === 1)
      return {
        content: '',
        toolCalls: [{ function: { name: 'set_layer_visibility', arguments: { layer: 'flights' } } }],
      };
    assert.equal(messages.at(-1).role, 'tool');
    for (const delta of ['Flights are on. ', 'Anything else?']) onToken(delta);
    return { content: 'Flights are on. Anything else?', toolCalls: [] };
  };
  await runTurn(s, 'show me live flights', { send, worker: fakeWorker(), chat });
  const types = sent.map((f) => f.type);
  assert.deepEqual(types.slice(0, 2), ['thinking', 'tool_call']);
  assert.ok(types.includes('audio_chunk'));
  assert.equal(sent.find((f) => f.type === 'text').text, 'Flights are on. Anything else?');
  assert.equal(types.at(-1), 'audio_end');
  // "Flights are on." is shorter than the splitter's minimum, so it is spoken
  // together with the sentence that follows it.
  assert.equal(sent.at(-1).chunks, 1);
  const chunkTexts = sent.filter((f) => f.type === 'audio_chunk').map((f) => f.text);
  assert.deepEqual(chunkTexts, ['Flights are on. Anything else?']);
  assert.equal(s.messages.at(-1).content, 'Flights are on. Anything else?');
  assert.equal(s.messages.filter((m) => m.role === 'tool').length, 1);
});

test('bare fly-to skips the model and the tool loop is capped', async () => {
  const s = session();
  const sent = [];
  let chats = 0;
  const send = (frame) => {
    sent.push(frame);
    if (frame.type === 'tool_call')
      setTimeout(() => s.pending.get(frame.callId)?.({ ok: true }), 0);
  };
  const chat = async () => {
    chats++;
    return { content: 'Done.', toolCalls: [] };
  };
  await runTurn(s, 'fly to Tokyo', { send, worker: fakeWorker({ tts: 'none' }), chat });
  assert.equal(sent[0].type, 'tool_call');
  assert.deepEqual(sent[0].arguments, { locationId: 'tokyo' });
  assert.equal(chats, 0, 'no model call for a deterministic fly-to');
  assert.equal(sent.find((f) => f.type === 'text').text, 'Flying to Tokyo.');
  assert.equal(sent.filter((f) => f.type === 'audio_chunk').length, 0);

  const looping = session();
  const loopSent = [];
  const loopSend = (frame) => {
    loopSent.push(frame);
    if (frame.type === 'tool_call')
      setTimeout(() => looping.pending.get(frame.callId)?.({ ok: true }), 0);
  };
  await runTurn(looping, 'keep going', {
    send: loopSend,
    worker: fakeWorker({ tts: 'none' }),
    chat: async () => ({ content: '', toolCalls: [{ function: { name: 'zoom_to_globe' } }] }),
  });
  assert.equal(loopSent.filter((f) => f.type === 'tool_call').length, MAX_TOOL_ROUNDS);
  assert.ok(loopSent.some((f) => f.type === 'error' && /limit/.test(f.error)));
  assert.equal(loopSent.at(-1).type, 'audio_end');
});

test('model failures are soft errors and a closed session aborts the turn', async () => {
  const s = session();
  const sent = [];
  await runTurn(s, 'hello', {
    send: (f) => sent.push(f),
    worker: fakeWorker({ tts: 'none' }),
    chat: async () => {
      throw new Error('Local model timed out (45 s)');
    },
  });
  const error = sent.find((f) => f.type === 'error');
  assert.equal(error.terminal, false);
  assert.match(error.error, /timed out/);

  const closer = new AbortController();
  const closing = { ...session(), closeSignal: closer.signal };
  const closedSent = [];
  const turn = runTurn(closing, 'zoom out', {
    send: (f) => closedSent.push(f),
    worker: fakeWorker({ tts: 'none' }),
    chat: async ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  closer.abort();
  await turn;
  assert.equal(closedSent.some((f) => f.type === 'error'), false);
  assert.equal(closedSent.some((f) => f.type === 'text'), false);
});

test('speech queue keeps chunk order and is a no-op without Piper', async () => {
  const sent = [];
  const queue = createSpeechQueue({
    session: {},
    turnId: 't',
    worker: fakeWorker(),
    send: (f) => sent.push(f),
    signal: new AbortController().signal,
  });
  queue.enqueue('One.');
  queue.enqueue('Two.');
  queue.enqueue('Three.');
  await queue.finish();
  assert.deepEqual(
    sent.map((f) => [f.type, f.seq]),
    [['audio_chunk', 0], ['audio_chunk', 1], ['audio_chunk', 2], ['audio_end', undefined]],
  );
  const silent = [];
  const none = createSpeechQueue({
    session: {},
    turnId: 't',
    worker: fakeWorker({ tts: 'none' }),
    send: (f) => silent.push(f),
    signal: new AbortController().signal,
  });
  none.enqueue('One.');
  await none.finish();
  assert.deepEqual(silent.map((f) => f.type), ['audio_end']);
});

test('remember phrases resolve deterministically and confirmations read well', async () => {
  const { deterministicRemember, deterministicConfirmation } = await import(
    '../../server/providers/ollama/fastPath.js'
  );
  for (const [text, name] of [
    ['Remember this place as my base', 'base'],
    ['remember this as Home.', 'Home'],
    ['Save the current view called the marina', 'marina'],
    ['Call this place office', 'office'],
    ['please bookmark this spot as "grandma"', 'grandma'],
  ])
    assert.deepEqual(
      deterministicRemember(text),
      { name: 'remember_place', arguments: { name } },
      text,
    );
  for (const text of ['Remember to call mom', 'Save it', 'Take me home', ''])
    assert.equal(deterministicRemember(text), null, text);
  assert.equal(
    deterministicConfirmation(
      { name: 'remember_place', arguments: { name: 'base' } },
      { ok: true, saved: 'base' },
    ),
    'Saved this view as base.',
  );
  assert.equal(
    deterministicConfirmation(
      { name: 'fly_to_location', arguments: { locationId: 'nyc' } },
      null,
    ),
    'Flying to New York City.',
  );
});

test('markdown is stripped from spoken text', async () => {
  const { stripMarkdown } = await import(
    '../../server/providers/ollama/sentences.js'
  );
  assert.equal(
    stripMarkdown('You have **one** alert:\n- **ID:** w1\n- Trigger: `radius`\n\n## Done'),
    'You have one alert:\nID: w1\nTrigger: radius\n\nDone',
  );
  assert.equal(stripMarkdown('Version 3.5 is *out* now.'), 'Version 3.5 is out now.');
  assert.equal(stripMarkdown(''), '');
});

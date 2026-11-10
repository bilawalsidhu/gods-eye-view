import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextChat } from './textChat.js';
import { t } from '../i18n/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (count = 8) => {
  for (let i = 0; i < count; i++) await tick();
};
const bytes = (value) =>
  new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).length;

// The wire shapes differ; the turn loop under test is shared.
const wire = {
  openai: {
    final: (text) => ({
      content: { role: 'assistant', content: text },
      finishReason: 'stop',
    }),
    calls: (count, prefix = 'call') => ({
      content: {
        role: 'assistant',
        content: null,
        tool_calls: Array.from({ length: count }, (_, index) => ({
          id: `${prefix}-${index}`,
          type: 'function',
          function: { name: 'fly_to', arguments: '{}' },
        })),
      },
    }),
    items: (body) => body.messages,
    userTexts: (items) =>
      items.filter((item) => item.role === 'user').map((item) => item.content),
    keyEnv: 'OPENAI_API_KEY',
  },
  gemini: {
    final: (text) => ({
      content: { role: 'model', parts: [{ text }] },
      finishReason: 'STOP',
    }),
    calls: (count, prefix = 'call') => ({
      content: {
        role: 'model',
        parts: Array.from({ length: count }, (_, index) => ({
          functionCall: { name: 'fly_to', args: {}, id: `${prefix}-${index}` },
        })),
      },
    }),
    items: (body) => body.contents,
    userTexts: (items) =>
      items
        .filter((item) => item.role === 'user' && item.parts[0].text)
        .map((item) => item.parts[0].text),
    keyEnv: 'GEMINI_API_KEY',
  },
};

function harness(provider, replies, options = {}) {
  const events = [];
  const requests = [];
  const actions = [];
  const chat = createTextChat({
    provider,
    emit: (event) => events.push(event),
    runAction: async (name, args, context) => {
      actions.push(name);
      return options.runAction
        ? options.runAction(name, args, context)
        : { ok: true };
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const reply = replies(requests.length, body, init);
      return reply instanceof Response ? reply : Response.json(reply);
    },
    ...options.chat,
  });
  const errors = () => events.filter((event) => event.state === 'error');
  const completions = (status = 'completed') =>
    events.filter(
      (event) => event.type === 'completion' && event.status === status,
    );
  return { chat, events, requests, actions, errors, completions };
}

for (const provider of ['openai', 'gemini']) {
  const w = wire[provider];

  test(`${provider}: a failed turn keeps the conversation for the next message`, async () => {
    const h = harness(provider, (n) =>
      n === 2
        ? Response.json({ error: 'unavailable' }, { status: 503 })
        : w.final(`Reply ${n}`),
    );
    h.chat.start();
    h.chat.sendText('First');
    await settle();
    h.chat.sendText('Second');
    await settle();
    assert.equal(h.errors().length, 1);
    assert.equal(h.errors()[0].detail, t('Could not connect. Try again.'));
    // The session stays usable: no restart is needed before the next send.
    assert.equal(h.chat.sendText('Third'), true);
    await settle();
    assert.deepEqual(w.userTexts(w.items(h.requests[2])), ['First', 'Third']);
    assert.equal(h.completions().length, 2);
    h.chat.stop();
  });

  test(`${provider}: a turn that fails after map actions keeps them for the next message`, async () => {
    const h = harness(provider, (n) =>
      n === 1
        ? w.calls(1)
        : n === 2
          ? Response.json({ error: 'unavailable' }, { status: 503 })
          : w.final('Done'),
    );
    h.chat.start();
    h.chat.sendText('Fly there');
    await settle();
    assert.equal(h.actions.length, 1);
    assert.equal(h.errors().length, 1);
    h.chat.sendText('Continue');
    await settle();
    const items = w.items(h.requests[2]);
    assert.deepEqual(w.userTexts(items), ['Fly there', 'Continue']);
    // Call, result, then a note that closes the stopped reply.
    const note = items.at(-2);
    const noteText = provider === 'openai' ? note.content : note.parts[0].text;
    assert.equal(note.role, provider === 'openai' ? 'assistant' : 'model');
    assert.match(
      noteText,
      /stopped before it finished; the results above are final/,
    );
    assert.equal(items.length, 5);
    h.chat.stop();
  });

  test(`${provider}: Stop during the second action keeps the first and marks the second cancelled`, async () => {
    let runs = 0;
    const h = harness(
      provider,
      (n) => (n === 1 ? w.calls(2) : w.final('Done')),
      {
        runAction: () => (++runs === 1 ? { ok: true } : new Promise(() => {})),
      },
    );
    h.chat.start();
    h.chat.sendText('Do both');
    await settle();
    assert.equal(runs, 2);
    assert.equal(h.chat.cancelTurn(), true);
    h.chat.sendText('Continue');
    await settle();
    const items = w.items(h.requests[1]);
    assert.deepEqual(w.userTexts(items), ['Do both', 'Continue']);
    const results =
      provider === 'openai'
        ? items
            .filter((item) => item.role === 'tool')
            .map((item) => JSON.parse(item.content))
        : items.flatMap((item) =>
            item.parts
              .filter((part) => part.functionResponse)
              .map((part) => part.functionResponse.response),
          );
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].cancelled, true, 'the action under way');
    const note = items.at(-2);
    assert.match(
      provider === 'openai' ? note.content : note.parts[0].text,
      /stopped before it finished; the results above are final/,
    );
    h.chat.stop();
  });

  test(`${provider}: Stop during the first of three actions keeps the round`, async () => {
    const h = harness(
      provider,
      (n) => (n === 1 ? w.calls(3) : w.final('Done')),
      {
        runAction: () => new Promise(() => {}),
      },
    );
    h.chat.start();
    h.chat.sendText('Do three');
    await settle();
    assert.equal(h.chat.cancelTurn(), true);
    h.chat.sendText('Continue');
    await settle();
    const items = w.items(h.requests[1]);
    assert.deepEqual(w.userTexts(items), ['Do three', 'Continue']);
    const results =
      provider === 'openai'
        ? items
            .filter((item) => item.role === 'tool')
            .map((item) => JSON.parse(item.content))
        : items.flatMap((item) =>
            item.parts
              .filter((part) => part.functionResponse)
              .map((part) => part.functionResponse.response),
          );
    assert.deepEqual(
      results.map((result) => result.reason),
      ['reply-stopped-while-running', 'reply-stopped', 'reply-stopped'],
    );
    h.chat.stop();
  });

  test(`${provider}: cancelTurn aborts only the reply in progress`, async () => {
    let toolSignal;
    const h = harness(
      provider,
      (n) => (n === 2 ? w.calls(1) : w.final(`Reply ${n}`)),
      {
        runAction: (_name, _args, context) => {
          toolSignal = context.signal;
          return new Promise(() => {});
        },
      },
    );
    h.chat.start();
    h.chat.sendText('First');
    await settle();
    h.chat.sendText('Second');
    await settle();
    assert.ok(toolSignal);
    assert.equal(h.chat.cancelTurn(), true);
    assert.equal(toolSignal.aborted, true);
    assert.equal(h.chat.cancelTurn(), false);
    assert.equal(h.completions('cancelled').length, 1);
    assert.equal(h.events.at(-2).state, 'listening');
    await settle();
    assert.equal(h.errors().length, 0);
    assert.equal(h.chat.sendText('Third'), true);
    await settle();
    assert.equal(h.requests.length, 3);
    // The stopped turn stays, with its action answered as cancelled.
    assert.deepEqual(w.userTexts(w.items(h.requests[2])), [
      'First',
      'Second',
      'Third',
    ]);
    // Ending the session still starts the next one fresh.
    h.chat.stop();
    h.chat.start();
    h.chat.sendText('Fresh');
    await settle();
    assert.deepEqual(w.userTexts(w.items(h.requests.at(-1))), ['Fresh']);
    h.chat.stop();
  });

  for (const [code, expected] of [
    [
      'API_KEY_MISSING',
      () =>
        t('Needs {envVars} — add it in Provider Settings', {
          envVars: w.keyEnv,
        }),
    ],
    [
      'CODEX_OAUTH_REQUIRED',
      () =>
        t(
          'Typed chat is unavailable while GEV_PREFER_CODEX_OAUTH requires ChatGPT OAuth.',
        ),
    ],
  ])
    test(`${provider}: a 503 ${code} reply names the fix`, async () => {
      const h = harness(provider, () =>
        Response.json({ error: 'Provider refused', code }, { status: 503 }),
      );
      h.chat.start();
      h.chat.sendText('Hello');
      await settle();
      assert.equal(h.errors().length, 1);
      assert.equal(h.errors()[0].detail, expected());
      h.chat.stop();
    });

  for (const [status, body, headers, expected] of [
    [
      502,
      { error: 'Refused', code: 'API_KEY_REJECTED' },
      {},
      () =>
        t('The provider rejected the API key. Check it in Provider Settings.'),
    ],
    [
      502,
      { error: 'Refused', code: 'ACCESS_DENIED' },
      {},
      () =>
        t(
          "The provider refused access for this key. Check the key's project, region or permissions.",
        ),
    ],
    [
      502,
      { error: 'Refused', code: 'QUOTA_EXCEEDED' },
      {},
      () =>
        t(
          'The provider account is out of credit. Check its billing, or choose another AI Provider in Settings.',
        ),
    ],
    [
      429,
      { error: 'Refused', code: 'RATE_LIMITED' },
      { 'Retry-After': '42' },
      () =>
        t('Too many chat requests. Try again in {seconds} s.', { seconds: 42 }),
    ],
    [
      429,
      { error: 'Refused' },
      {},
      () =>
        t('Too many chat requests. Try again in {seconds} s.', { seconds: 60 }),
    ],
  ])
    test(`${provider}: a ${status} ${body.code ?? 'throttle'} reply says what to do`, async () => {
      const h = harness(provider, () =>
        Response.json(body, { status, headers }),
      );
      h.chat.start();
      h.chat.sendText('Hello');
      await settle();
      assert.equal(h.errors()[0].detail, expected());
      h.chat.stop();
    });

  test(`${provider}: a gateway timeout without a JSON body still reads as a timeout`, async () => {
    const h = harness(
      provider,
      () => new Response('<html>Gateway Timeout</html>', { status: 504 }),
    );
    h.chat.start();
    h.chat.sendText('Hello');
    await settle();
    assert.equal(h.errors()[0].detail, t('Connection timed out. Try again.'));
    h.chat.stop();
  });

  test(`${provider}: a round with 17 calls hits the call cap before any action`, async () => {
    const h = harness(provider, () => w.calls(17));
    h.chat.start();
    h.chat.sendText('Do everything');
    await settle();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.actions, []);
    assert.equal(
      h.errors()[0].detail,
      t('That request needed too many steps. Try a simpler request.'),
    );
    h.chat.stop();
  });

  test(`${provider}: the round limit says applied map changes stay`, async () => {
    const h = harness(provider, (n) => w.calls(1, `round-${n}`));
    h.chat.start();
    h.chat.sendText('Keep going');
    await settle(30);
    assert.equal(h.requests.length, 8);
    assert.equal(h.actions.length, 8);
    assert.equal(
      h.errors()[0].detail,
      t(
        'That request needed too many steps. Changes already made to the map stay in place.',
      ),
    );
    h.chat.stop();
  });

  test(`${provider}: the deadline covers each request, not the whole turn`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let pending = 0;
    const h = harness(
      provider,
      (n) => (n < 3 ? w.calls(1, `round-${n}`) : w.final('Done')),
      {
        chat: { timeoutMs: 50 },
        runAction: () =>
          new Promise((resolve) => {
            pending++;
            setTimeout(() => resolve({ ok: true }), 40);
          }),
      },
    );
    h.chat.start();
    h.chat.sendText('Two slow steps');
    for (const expected of [1, 2]) {
      await settle();
      assert.equal(pending, expected);
      context.mock.timers.tick(40);
    }
    await settle();
    assert.equal(h.errors().length, 0);
    assert.equal(h.completions().length, 1);
    h.chat.stop();
  });

  test(`${provider}: each map action in a round gets its own deadline`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let pending = 0;
    const h = harness(provider, (n) => (n < 2 ? w.calls(3) : w.final('Done')), {
      chat: { timeoutMs: 50 },
      runAction: () =>
        new Promise((resolve) => {
          pending++;
          setTimeout(() => resolve({ ok: true }), 40);
        }),
    });
    h.chat.start();
    h.chat.sendText('Three slow steps');
    // One request, then three 40 ms actions: 120 ms against a 50 ms deadline.
    for (const expected of [1, 2, 3]) {
      await settle();
      assert.equal(pending, expected);
      context.mock.timers.tick(40);
    }
    await settle();
    assert.equal(h.errors().length, 0);
    assert.equal(h.completions().length, 1);
    h.chat.stop();
  });
}

test('long history shortens old tool results and keeps every call paired', async () => {
  const w = wire.openai;
  let turn = 0;
  const h = harness(
    'openai',
    (n, body) => {
      const last = body.messages.at(-1);
      return last.role === 'user'
        ? w.calls(1, `turn-${++turn}`)
        : w.final('Ok');
    },
    {
      runAction: async () => ({
        ok: true,
        say: 'Found',
        records: ['x'.repeat(11000)],
      }),
    },
  );
  h.chat.start();
  for (let i = 1; i <= 20; i++) {
    assert.equal(h.chat.sendText(`Turn ${i}`), true);
    await settle();
  }
  assert.equal(h.completions().length, 20);
  const messages = h.requests.at(-1).messages;
  assert.equal(messages[0].role, 'user');
  assert.ok(messages.length <= 64 + 3);
  const calls = new Set();
  for (const message of messages) {
    for (const call of message.tool_calls || []) calls.add(call.id);
    if (message.role === 'tool') {
      assert.ok(calls.delete(message.tool_call_id), message.tool_call_id);
      const result = JSON.parse(message.content);
      assert.equal(result.ok, true);
      assert.equal(result.say, 'Found');
    }
  }
  assert.deepEqual([...calls], []);
  const results = messages.filter((message) => message.role === 'tool');
  // Earlier turns are compact; the latest turns keep their full result.
  assert.ok(results.slice(0, -2).every((item) => bytes(item.content) <= 1500));
  assert.ok(results.slice(-2).every((item) => bytes(item.content) > 10000));
});

test('a request over the size cap drops old turns instead of failing', async () => {
  const w = wire.gemini;
  const big = (char, size) => char.repeat(size);
  let turn = 0;
  const h = harness('gemini', (n, body) => {
    const last = body.contents.at(-1);
    const text = last.parts[0].text;
    if (text && turn < 4) {
      turn++;
      return w.final(big('a', 40000));
    }
    if (text)
      return {
        content: {
          role: 'model',
          parts: [
            { text: big('b', 380000) },
            { functionCall: { name: 'fly_to', args: {}, id: 'large' } },
          ],
        },
      };
    return w.final('Done');
  });
  h.chat.start();
  for (let i = 1; i <= 5; i++) {
    h.chat.sendText(`Turn ${i}`);
    await settle();
  }
  assert.equal(h.errors().length, 0);
  assert.equal(h.completions().length, 5);
  const request = h.requests.at(-1);
  assert.ok(bytes(request) <= 512 * 1024);
  const texts = w.userTexts(request.contents);
  assert.equal(texts.at(-1), 'Turn 5');
  assert.ok(!texts.includes('Turn 1'));
  assert.equal(request.contents[0].role, 'user');
  assert.ok(request.contents[0].parts[0].text);
});

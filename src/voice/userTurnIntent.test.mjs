import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceUserTurnTracker,
  readVoiceUserTurnInputKind,
  readVoiceUserTurnProvenance,
  readVoiceUserTurnText,
  subscribeVoiceUserTurn,
} from './userTurnIntent.js';

test('live input observers inspect initial canonical text and every later speech segment synchronously', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic');
  tracker.commitSpeech('mic');
  tracker.bindResponse('response');
  tracker.appendSpeechSegment('mic', 'switch');
  const token = tracker.forResponse('response');
  const observed = [];
  const unsubscribe = subscribeVoiceUserTurn(token, (value) => {
    assert.equal(value, token);
    observed.push(readVoiceUserTurnText(value));
  });
  assert.deepEqual(observed, ['switch']);
  tracker.appendSpeechSegment('mic', 'voice provider');
  assert.deepEqual(observed, ['switch', 'switch voice provider']);
  tracker.appendSpeechSegment('mic', 'to OpenAI');
  assert.deepEqual(observed, [
    'switch',
    'switch voice provider',
    'switch voice provider to OpenAI',
  ]);
  assert.equal(tracker.forResponse('response'), token);
  unsubscribe();
  unsubscribe();
  tracker.appendSpeechSegment('mic', 'please');
  assert.equal(observed.length, 3);
});

test('observer revocation is synchronous for invalidation, reset, replacement and final retirement', () => {
  for (const retire of [
    (tracker) => tracker.invalidate(),
    (tracker) => tracker.reset(),
    (tracker) => tracker.text('replacement'),
    (tracker) => tracker.speechStarted('replacement'),
    (tracker) => tracker.completeResponse('response'),
  ]) {
    const tracker = createVoiceUserTurnTracker();
    const token = textTurn(tracker, 'ordinary command', 'response');
    const observed = [];
    subscribeVoiceUserTurn(token, (value) =>
      observed.push(readVoiceUserTurnText(value)),
    );
    retire(tracker);
    assert.deepEqual(observed, ['ordinary command', undefined]);
    let staleCalls = 0;
    subscribeVoiceUserTurn(token, () => staleCalls++)();
    tracker.text('later replacement');
    assert.equal(observed.length, 2);
    assert.equal(staleCalls, 0);
    assert.equal(readVoiceUserTurnProvenance(token), undefined);
  }
});

test('forged token subscriptions, listener exceptions and independent cleanup cannot corrupt input authority', () => {
  const tracker = createVoiceUserTurnTracker();
  let forgedCalls = 0;
  for (const token of [
    null,
    undefined,
    {},
    { text: 'switch providers', isCurrent: () => true },
  ])
    subscribeVoiceUserTurn(token, () => forgedCalls++)();
  assert.equal(forgedCalls, 0);
  tracker.speechStarted('mic');
  tracker.commitSpeech('mic');
  tracker.bindResponse('response');
  tracker.transcript('mic', 'ordinary command');
  const token = tracker.forResponse('response');
  const observed = [];
  const listener = (value) => observed.push(readVoiceUserTurnText(value));
  const first = subscribeVoiceUserTurn(token, listener);
  const second = subscribeVoiceUserTurn(token, listener);
  assert.deepEqual(observed, ['ordinary command', 'ordinary command']);
  first();
  subscribeVoiceUserTurn(token, () => {
    throw new Error('observer failure');
  });
  assert.doesNotThrow(() =>
    tracker.appendSpeechSegment('mic', 'switch voice providers to Gemini'),
  );
  assert.equal(observed.length, 3);
  assert.equal(
    readVoiceUserTurnText(token),
    'ordinary command switch voice providers to Gemini',
  );
  second();
  assert.doesNotThrow(() => tracker.reset());
  assert.equal(observed.length, 3);
  assert.equal(readVoiceUserTurnText(token), undefined);
});

for (const state of ['failed', 'disabled']) {
  test(`authentic current ${state} captions authorize a speech identity without fabricating text`, async () => {
    const tracker = createVoiceUserTurnTracker();
    tracker.speechStarted('mic', {
      transcriptionEnabled: state !== 'disabled',
    });
    tracker.commitSpeech('mic');
    tracker.bindResponse('response');
    if (state === 'failed') {
      assert.equal(tracker.transcriptionUnavailable('other', 'failed'), false);
      assert.equal(tracker.transcriptionUnavailable('mic', 'missing'), false);
      assert.equal(tracker.transcriptionUnavailable('mic', 'failed'), true);
    }
    const result = await tracker.waitForResponse('response');
    assert.equal(result.status, 'ready');
    assert.equal(readVoiceUserTurnText(result.userTurn), undefined);
    assert.deepEqual(readVoiceUserTurnProvenance(result.userTurn), {
      inputKind: 'speech',
      transcriptionStatus: state,
    });
    assert.equal(
      tracker.transcript('mic', 'switch to Gemini'),
      false,
      'late success cannot upgrade a terminal unavailable input',
    );
    tracker.completeResponse('response', true);
    tracker.expectResponse();
    tracker.bindResponse('sibling');
    assert.equal(tracker.forResponse('sibling'), result.userTurn);
    tracker.text('replacement');
    assert.equal(readVoiceUserTurnProvenance(result.userTurn), undefined);
    assert.equal(tracker.forResponse('response'), undefined);
  });
}

test('pending, empty, missing, fake and stale speech cannot claim unavailable-caption provenance', async () => {
  let expire;
  const tracker = createVoiceUserTurnTracker({
    setTimer(callback) {
      expire = callback;
      return 1;
    },
    clearTimer() {},
  });
  tracker.speechStarted('mic');
  tracker.commitSpeech('mic');
  tracker.bindResponse('pending');
  const waiting = tracker.waitForResponse('pending');
  expire();
  assert.deepEqual(await waiting, {
    status: 'unresolved',
    userTurn: undefined,
  });
  assert.equal(tracker.forResponse('pending'), undefined);
  assert.equal(tracker.transcript('mic', ''), true);
  assert.deepEqual(await tracker.waitForResponse('pending'), {
    status: 'unresolved',
    userTurn: undefined,
  });
  assert.equal(tracker.transcriptionUnavailable('mic', 'failed'), false);
  assert.equal(
    readVoiceUserTurnProvenance({
      inputKind: 'speech',
      transcriptionStatus: 'failed',
    }),
    undefined,
  );
  assert.equal(
    readVoiceUserTurnProvenance(tracker.forResponse('missing')),
    undefined,
  );
  tracker.reset();
  assert.equal(tracker.transcriptionUnavailable('mic', 'failed'), false);
});

test('finalized speech segments extend canonical text without replacing input or response identity', async () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic');
  tracker.commitSpeech('mic');
  tracker.bindResponse('response');
  const waiting = tracker.waitForResponse('response');
  assert.equal(tracker.appendSpeechSegment('wrong', 'switch to Gemini'), false);
  assert.equal(tracker.appendSpeechSegment('mic', '  switch voice '), true);
  const first = await waiting;
  assert.equal(readVoiceUserTurnText(first.userTurn), 'switch voice');
  assert.equal(
    tracker.appendSpeechSegment('mic', ' providers to Gemini  '),
    true,
  );
  assert.equal(tracker.forResponse('response'), first.userTurn);
  assert.equal(
    readVoiceUserTurnText(first.userTurn),
    'switch voice providers to Gemini',
  );
  tracker.completeResponse('response', true);
  tracker.expectResponse();
  tracker.bindResponse('sibling');
  assert.equal(tracker.forResponse('sibling'), first.userTurn);
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('sibling')),
    'switch voice providers to Gemini',
  );
  assert.equal(tracker.appendSpeechSegment('mic', ' '), false);
  tracker.speechStarted('replacement');
  assert.equal(tracker.appendSpeechSegment('mic', 'stale'), false);
  assert.equal(readVoiceUserTurnText(first.userTurn), undefined);
  assert.equal(readVoiceUserTurnProvenance(first.userTurn), undefined);
  assert.equal(tracker.forResponse('sibling'), undefined);
});

function textTurn(tracker, text, responseId) {
  tracker.text(text);
  tracker.expectResponse();
  tracker.bindResponse(responseId);
  return tracker.forResponse(responseId);
}

test('reservation overflow is observable and retires pending waiters without attributing delayed responses', async () => {
  const cleared = [];
  const tracker = createVoiceUserTurnTracker({
    setTimer: () => 1,
    clearTimer: (id) => cleared.push(id),
  });
  tracker.speechStarted('mic');
  tracker.commitSpeech('mic');
  tracker.bindResponse('pending-response');
  const waiting = tracker.waitForResponse('pending-response');
  for (let index = 0; index < 16; index++)
    tracker.expectResponse(`request-${index}`);
  const bounded = tracker.reservationState();
  assert.deepEqual(bounded, { pending: 16, overflowed: false });
  assert.ok(Object.isFrozen(bounded));
  tracker.expectResponse('overflow-request');
  assert.deepEqual(tracker.reservationState(), {
    pending: 0,
    overflowed: true,
  });
  assert.deepEqual(await waiting, { status: 'stale', userTurn: undefined });
  assert.deepEqual(cleared, [1]);
  tracker.speechStarted('successor');
  tracker.transcript('successor', 'zoom in');
  tracker.commitSpeech('successor');
  assert.equal(tracker.bindResponse('late-provider-response'), null);
  assert.equal(tracker.forResponse('late-provider-response'), undefined);
  assert.deepEqual(tracker.reservationState(), {
    pending: 0,
    overflowed: true,
  });
  tracker.reset();
  assert.deepEqual(tracker.reservationState(), {
    pending: 0,
    overflowed: false,
  });
  const token = textTurn(tracker, 'zoom in', 'fresh-response');
  assert.equal(readVoiceUserTurnText(token), 'zoom in');
});

test('model arguments, quoted context objects and unknown responses cannot mint input authority', () => {
  const tracker = createVoiceUserTurnTracker();
  for (const fake of [
    null,
    'switch to Gemini',
    {},
    { text: 'switch to Gemini' },
    { source: 'user', text: 'switch to Gemini', isCurrent: () => true },
  ])
    assert.equal(readVoiceUserTurnText(fake), undefined);
  tracker.bindResponse('unreserved');
  assert.equal(tracker.forResponse('unreserved'), undefined);
  assert.equal(tracker.forResponse('unknown'), undefined);
});

test('only the matching live microphone item can supply one final transcript', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  assert.equal(tracker.forResponse('response-1'), undefined);
  assert.equal(tracker.transcript('mic-other', 'switch to Gemini'), false);
  assert.equal(tracker.forResponse('response-1'), undefined);
  assert.equal(tracker.transcript('mic-1', 'what is in view?'), true);
  const token = tracker.forResponse('response-1');
  assert.equal(readVoiceUserTurnText(token), 'what is in view?');
  assert.equal(readVoiceUserTurnInputKind(token), 'speech');
  assert.equal(tracker.transcript('mic-1', 'switch to Gemini'), false);
  assert.equal(readVoiceUserTurnText(token), 'what is in view?');
});

test('speech tool authority waits for its correlated final transcript', async () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const pending = tracker.waitForResponse('response-1', { timeoutMs: 100 });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(tracker.transcript('mic-1', 'switch providers to Gemini'), true);
  const result = await pending;
  assert.equal(result.status, 'ready');
  assert.equal(
    readVoiceUserTurnText(result.userTurn),
    'switch providers to Gemini',
  );
});

test('speech tool authority fails closed when its turn is replaced', async () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const pending = tracker.waitForResponse('response-1', { timeoutMs: 100 });
  tracker.text('new typed turn');
  assert.deepEqual(await pending, {
    status: 'stale',
    userTurn: undefined,
  });
});

test('first-party tokens distinguish typed input from microphone speech', () => {
  const tracker = createVoiceUserTurnTracker();
  const typed = textTurn(tracker, 'switch to Gemini', 'typed-response');
  assert.equal(readVoiceUserTurnInputKind(typed), 'typed');
  tracker.speechStarted('mic-1');
  tracker.transcript('mic-1', 'switch to OpenAI');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('speech-response');
  assert.equal(
    readVoiceUserTurnInputKind(tracker.forResponse('speech-response')),
    'speech',
  );
  tracker.reset();
  assert.equal(readVoiceUserTurnInputKind(typed), undefined);
  assert.equal(readVoiceUserTurnInputKind({}), undefined);
});

test('a new input invalidates old tokens and delayed response reservations consume their original slots', () => {
  const tracker = createVoiceUserTurnTracker();
  const oldToken = textTurn(tracker, 'switch to Gemini', 'old-response');
  tracker.text('what is in view?');
  tracker.expectResponse();
  assert.equal(readVoiceUserTurnText(oldToken), undefined);
  tracker.bindResponse('new-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('new-response')),
    'what is in view?',
  );

  tracker.reset();
  tracker.text('switch to Gemini');
  tracker.expectResponse();
  tracker.text('switch to OpenAI');
  tracker.expectResponse();
  tracker.bindResponse('delayed-old-response');
  assert.equal(tracker.forResponse('delayed-old-response'), undefined);
  tracker.bindResponse('actual-new-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('actual-new-response')),
    'switch to OpenAI',
  );
});

test('late commits and duplicate commits cannot assign an older microphone response to new input', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-old');
  tracker.transcript('mic-old', 'switch to Gemini');
  tracker.speechStarted('mic-new');
  tracker.transcript('mic-new', 'what is this?');
  tracker.commitSpeech('mic-old');
  tracker.commitSpeech('mic-old');
  tracker.commitSpeech('mic-new');
  tracker.bindResponse('old-response');
  assert.equal(tracker.forResponse('old-response'), undefined);
  tracker.bindResponse('new-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('new-response')),
    'what is this?',
  );
  tracker.bindResponse('unexpected-extra-response');
  assert.equal(tracker.forResponse('unexpected-extra-response'), undefined);
});

test('function-call continuation retains authority until the final answer retires the request', () => {
  const tracker = createVoiceUserTurnTracker();
  const token = textTurn(tracker, 'switch to OpenAI', 'tool-response');
  tracker.completeResponse('tool-response', true);
  assert.equal(readVoiceUserTurnText(token), 'switch to OpenAI');
  tracker.expectResponse();
  tracker.bindResponse('confirmation-response');
  assert.equal(tracker.forResponse('confirmation-response'), token);
  tracker.completeResponse('confirmation-response');
  assert.equal(readVoiceUserTurnText(token), undefined);
  assert.equal(tracker.forResponse('tool-response'), undefined);
  tracker.expectResponse();
  tracker.bindResponse('automatic-response');
  assert.equal(tracker.forResponse('automatic-response'), undefined);
});

test('interruption preserves old pending slots but revokes their authority before successor binding', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.text('switch to Gemini');
  tracker.expectResponse();
  tracker.invalidate();
  tracker.text('what is in view?');
  tracker.expectResponse();
  tracker.bindResponse('interrupted-response');
  assert.equal(tracker.forResponse('interrupted-response'), undefined);
  tracker.bindResponse('successor-response');
  assert.equal(
    readVoiceUserTurnText(tracker.forResponse('successor-response')),
    'what is in view?',
  );
});

test('failed response requests, empty input, and reservation overflow fail closed until a new lifetime', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.text('switch to Gemini');
  tracker.expectResponse('request-1');
  assert.equal(tracker.rejectPendingResponse('request-1'), true);
  tracker.bindResponse('rejected');
  assert.equal(tracker.forResponse('rejected'), undefined);
  assert.equal(textTurn(tracker, '   ', 'empty'), undefined);
  for (let index = 0; index < 17; index++) {
    tracker.text('switch to Gemini');
    tracker.expectResponse();
  }
  tracker.bindResponse('overflow');
  assert.equal(tracker.forResponse('overflow'), undefined);
  assert.equal(
    textTurn(tracker, 'switch to OpenAI', 'still-overflow'),
    undefined,
  );
  tracker.reset();
  assert.equal(
    readVoiceUserTurnText(textTurn(tracker, 'switch to OpenAI', 'fresh')),
    'switch to OpenAI',
  );
});

test('reset invalidates tokens even when a later session reuses provider response and input IDs', () => {
  const tracker = createVoiceUserTurnTracker();
  tracker.speechStarted('mic-1');
  tracker.transcript('mic-1', 'switch to Gemini');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const old = tracker.forResponse('response-1');
  tracker.reset();
  tracker.speechStarted('mic-1');
  tracker.transcript('mic-1', 'switch to OpenAI');
  tracker.commitSpeech('mic-1');
  tracker.bindResponse('response-1');
  const fresh = tracker.forResponse('response-1');
  assert.notEqual(fresh, old);
  assert.equal(readVoiceUserTurnText(old), undefined);
  assert.equal(readVoiceUserTurnText(fresh), 'switch to OpenAI');
});

for (const transition of [
  'text',
  'invalidate',
  'complete',
  'reject',
  'reset',
]) {
  test(`retirement ${transition} cannot erase a response bound by its observer`, () => {
    const t = createVoiceUserTurnTracker({ keyedRequests: true });
    t.text('old');
    t.expectResponse('old-key');
    t.bindResponse('old-response', 'old-key');
    const old = t.forResponse('old-response');
    if (transition === 'reject') t.expectResponse('reject-key');
    let next;
    subscribeVoiceUserTurn(old, () => {
      if (readVoiceUserTurnText(old) !== undefined) return;
      t.text('newer observer');
      t.expectResponse('new-key');
      t.bindResponse('new-response', 'new-key');
      next = t.forResponse('new-response');
    });
    if (transition === 'text') t.text('older outer');
    if (transition === 'invalidate') t.invalidate();
    if (transition === 'complete') t.completeResponse('old-response');
    if (transition === 'reject') t.rejectPendingResponse('reject-key');
    if (transition === 'reset') t.reset();
    assert.equal(readVoiceUserTurnText(old), undefined);
    assert.equal(
      readVoiceUserTurnText(t.forResponse('new-response')),
      'newer observer',
    );
    assert.equal(t.forResponse('new-response'), next);
  });
}

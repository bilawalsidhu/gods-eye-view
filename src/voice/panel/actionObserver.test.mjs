import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createPanelActionObserver } from './actionObserver.js';
import { createVoiceSession } from '../session.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('sync value/throw, receiver, arguments and opaque unsupported result stay exact', () => {
  const receiver = {},
    args = {},
    options = { extra: 7 };
  const error = Error('original');
  let calls = 0;
  const events = [];
  const observer = createPanelActionObserver({
    onObservation: (event) => events.push(event),
    runAction(name, received, opts, tail) {
      assert.equal(this, receiver);
      assert.equal(received, args);
      assert.equal(opts.extra, 7);
      assert.equal(tail, 'tail');
      calls++;
      if (name === 'throw') throw error;
      return 42;
    },
  });
  assert.equal(
    observer.runAction.call(receiver, 'value', args, options, 'tail'),
    42,
  );
  assert.throws(
    () => observer.runAction.call(receiver, 'throw', args, options, 'tail'),
    (e) => e === error,
  );
  assert.equal(calls, 2);
  assert.equal(observer.pendingCount, 0);
  assert.deepEqual(
    events.filter((e) => e.type === 'attempt-settled').map((e) => e.outcome),
    ['synchronous-return', 'synchronous-throw'],
  );
  const opaque = Object.defineProperty({}, 'then', {
    get() {
      throw Error('must not read then');
    },
  });
  const another = createPanelActionObserver({ runAction: () => opaque });
  assert.equal(another.runAction('opaque'), opaque);
  assert.equal(another.pendingCount, 0);
});

test('native Promise identity, fulfillment object and rejection object are preserved', async () => {
  for (const reject of [false, true]) {
    const d = deferred(),
      value = { exact: true },
      events = [];
    const observer = createPanelActionObserver({
      runAction: () => d.promise,
      onObservation: (e) => events.push(e),
    });
    const returned = observer.runAction('promise');
    assert.equal(returned, d.promise);
    assert.equal(observer.pendingCount, 1);
    if (reject) {
      d.reject(value);
      await assert.rejects(returned, (e) => e === value);
    } else {
      d.resolve(value);
      assert.equal(await returned, value);
    }
    assert.equal(observer.pendingCount, 0);
    assert.equal(events.at(-1).outcome, reject ? 'rejected' : 'fulfilled');
    assert.equal('result' in events.at(-1), false);
    assert.equal('error' in events.at(-1), false);
  }
});

test('null/reused callIds have independent keys and settlement cannot retire a sibling', async () => {
  const a = deferred(),
    b = deferred(),
    events = [];
  const observer = createPanelActionObserver({
    runAction: (name) => (name === 'a' ? a.promise : b.promise),
    onObservation: (e) => events.push(e),
  });
  const pa = observer.runAction('a', {}, { callId: null });
  const pb = observer.runAction('b', {}, { callId: null });
  const starts = events.filter((e) => e.type === 'attempt-started');
  assert.notEqual(starts[0].key, starts[1].key);
  assert.equal(observer.pendingCount, 2);
  b.resolve('b');
  await pb;
  assert.equal(observer.pendingCount, 1);
  assert.equal(events.at(-1).key, starts[1].key);
  a.resolve('a');
  await pa;
  assert.equal(observer.pendingCount, 0);
});

test('progress preserves public-before-original-before-private order, receiver and option references', async () => {
  const order = [],
    signal = new AbortController().signal,
    symbol = Symbol('unknown');
  let currentCalls = 0;
  const isCurrent = () => {
    currentCalls++;
    return true;
  };
  const options = {
    signal,
    isCurrent,
    progress(update) {
      assert.equal(this, options);
      order.push('original');
      return update;
    },
  };
  Object.defineProperty(options, 'hidden', { value: 8 });
  options[symbol] = 9;
  const custom = {};
  const observer = createPanelActionObserver({
    onObservation(e) {
      if (e.type === 'progress') order.push('private');
    },
    runAction(name, args, received) {
      assert.equal(received.signal, signal);
      assert.equal(received.isCurrent, isCurrent);
      assert.equal(received.hidden, 8);
      assert.equal(received[symbol], 9);
      assert.equal(
        Object.getOwnPropertyDescriptor(received, 'hidden').enumerable,
        false,
      );
      order.push('public');
      assert.equal(received.progress({ step: 'running' }).step, 'running');
      return Promise.resolve();
    },
  });
  await observer.runAction('action', {}, options);
  assert.deepEqual(order, ['public', 'original', 'private']);
  assert.equal(currentCalls, 0);
  const explicit = createPanelActionObserver({
    runAction(name, args, received) {
      received.progress.call(custom, { step: 'running' });
      return 0;
    },
  });
  let originalReceiver;
  explicit.runAction(
    'explicit',
    {},
    {
      progress() {
        originalReceiver = this;
      },
    },
  );
  assert.equal(originalReceiver, custom);
});

test('observer faults and private metadata faults cannot replace original callback errors', async () => {
  const originalError = Error('callback');
  const observer = createPanelActionObserver({
    onObservation() {
      throw Error('observer');
    },
    runAction(name, args, options) {
      options.progress({ step: 'work' });
      return Promise.resolve('ok');
    },
  });
  await assert.rejects(
    Promise.resolve().then(() =>
      observer.runAction(
        'error',
        {},
        {
          progress() {
            throw originalError;
          },
        },
      ),
    ),
    (e) => e === originalError,
  );
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error('private read');
      },
    },
  );
  const safe = createPanelActionObserver({
    runAction(name, args, options) {
      options.progress(hostile);
      return Promise.resolve('unchanged');
    },
    onObservation() {
      throw Error('observer');
    },
  });
  assert.equal(await safe.runAction('safe', {}, {}), 'unchanged');
});

test('accessor/custom options are forwarded untouched without extra getter/currentness probes', async () => {
  let reads = 0,
    predicates = 0;
  const options = Object.defineProperty(
    {
      isCurrent() {
        predicates++;
        return true;
      },
    },
    'progress',
    {
      get() {
        reads++;
        return () => {};
      },
    },
  );
  const observer = createPanelActionObserver({
    runAction(name, args, received) {
      assert.equal(received, options);
      received.progress({});
      received.isCurrent();
      return Promise.resolve();
    },
  });
  await observer.runAction('accessor', {}, options);
  assert.equal(reads, 1);
  assert.equal(predicates, 1);
  assert.equal(observer.pendingCount, 0);
});

test('real caller abort retires ownership only; late A cannot release or report over B', async () => {
  const a = deferred(),
    b = deferred(),
    caller = new AbortController(),
    events = [],
    callbacks = [];
  let oldOptions;
  const observer = createPanelActionObserver({
    onObservation: (e) => events.push(e),
    runAction(name, args, options) {
      if (name === 'a') oldOptions = options;
      return name === 'a' ? a.promise : b.promise;
    },
  });
  const pa = observer.runAction(
    'a',
    {},
    { signal: caller.signal, progress: () => callbacks.push('original') },
  );
  caller.abort();
  assert.equal(observer.pendingCount, 0);
  assert.equal(events.at(-1).type, 'ownership-retired');
  assert.equal(
    events.some((e) => e.type === 'attempt-settled'),
    false,
  );
  const pb = observer.runAction('b');
  const count = events.length;
  oldOptions.progress({ step: 'late' });
  a.resolve('a');
  await pa;
  assert.deepEqual(callbacks, ['original']);
  assert.equal(events.length, count);
  assert.equal(observer.pendingCount, 1);
  b.resolve('b');
  await pb;
  assert.equal(observer.pendingCount, 0);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('already-aborted caller and disposed mount still invoke original exactly once', async () => {
  const caller = new AbortController(),
    mount = new AbortController();
  caller.abort();
  let calls = 0;
  const events = [];
  const observer = createPanelActionObserver({
    signal: mount.signal,
    onObservation: (e) => events.push(e),
    runAction: () => {
      calls++;
      return Promise.resolve('original');
    },
  });
  assert.equal(
    await observer.runAction('aborted', {}, { signal: caller.signal }),
    'original',
  );
  assert.equal(observer.pendingCount, 0);
  mount.abort();
  assert.equal(await observer.runAction('disposed'), 'original');
  assert.equal(calls, 2);
  assert.equal(events.length, 0);
  assert.equal(getEventListeners(mount.signal, 'abort').length, 0);
});

test('reentrant start retirement retains only fresh ownership and never skips execution', async () => {
  const a = deferred(),
    b = deferred(),
    called = [];
  let observer, pb;
  observer = createPanelActionObserver({
    runAction(name) {
      called.push(name);
      return name === 'a' ? a.promise : b.promise;
    },
    onObservation(e) {
      if (e.type === 'attempt-started' && e.name === 'a') {
        observer.retire('actual-interruption');
        pb = observer.runAction('b');
      }
    },
  });
  const pa = observer.runAction('a');
  assert.deepEqual(called, ['b', 'a']);
  assert.equal(observer.pendingCount, 1);
  a.resolve();
  await pa;
  assert.equal(observer.pendingCount, 1);
  b.resolve();
  await pb;
  assert.equal(observer.pendingCount, 0);
});

test('actual pinned-main common session: private invocation stream is separate from public events', async (t) => {
  const publicEvents = [],
    privateEvents = [],
    order = [];
  let hooks, observer;
  const result = { ok: true, unchanged: true };
  const session = createVoiceSession({
    runner: async (name, args, options) => {
      assert.equal(options.isCurrent(), true);
      options.progress({ step: 'actual', label: 'Actual' });
      return result;
    },
    createAdapter(h) {
      hooks = h;
      observer = createPanelActionObserver({
        runAction: h.runAction,
        signal: h.signal,
        onObservation(e) {
          privateEvents.push(e);
          if (e.type === 'progress') order.push('private');
        },
      });
      return {
        start() {
          h.emit({ type: 'state', state: 'listening' });
        },
        stop() {},
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  t.after(() => session.destroy());
  session.subscribe((e) => {
    publicEvents.push(e);
    if (e.type === 'progress') order.push('public');
  });
  await session.start();
  assert.equal(
    await observer.runAction(
      'actual',
      {},
      {
        progress() {
          order.push('caller');
        },
      },
    ),
    result,
  );
  assert.deepEqual(order, ['public', 'caller', 'private']);
  const call = publicEvents.find((e) => e.type === 'action-call');
  assert.deepEqual(call, {
    type: 'action-call',
    name: 'actual',
    callId: null,
    arguments: {},
  });
  assert.equal(
    publicEvents.some((e) => e.type === 'action-settled'),
    false,
  );
  assert.equal(privateEvents.at(-1).type, 'attempt-settled');
  assert.equal(observer.pendingCount, 0);
  assert.equal(hooks.signal.aborted, false);
});

test('actual common interruption aborts resources; injected real-lifecycle observation retires uncooperative A', async (t) => {
  const a = deferred(),
    b = deferred(),
    events = [];
  let hooks, observer, aSignal;
  const session = createVoiceSession({
    runner: (name, args, options) => {
      if (name === 'a') aSignal = options.signal;
      return name === 'a' ? a.promise : b.promise;
    },
    createAdapter(h) {
      hooks = h;
      observer = createPanelActionObserver({
        runAction: h.runAction,
        signal: h.signal,
        onObservation: (e) => events.push(e),
      });
      return {
        start() {
          h.emit({ type: 'state', state: 'listening' });
        },
        stop() {},
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  t.after(() => session.destroy());
  await session.start();
  const pa = observer.runAction('a');
  const rejection = assert.rejects(pa, { name: 'AbortError' });
  hooks.emit({ type: 'interruption', reason: 'actual-common-event' });
  assert.equal(aSignal.aborted, true);
  // This bridge is explicitly supplied by the test, not automatically inferred.
  observer.retire('observed-common-interruption');
  assert.equal(observer.pendingCount, 0);
  const pb = observer.runAction('b');
  const count = events.length;
  a.resolve({ ok: true });
  await rejection;
  assert.equal(events.length, count);
  assert.equal(observer.pendingCount, 1);
  b.resolve({ ok: true });
  await pb;
  assert.equal(observer.pendingCount, 0);
});

test('null-prototype option descriptors survive instrumentation; mount abort does not fabricate settlement', async () => {
  const mount = new AbortController(),
    d = deferred(),
    events = [],
    originalProgress = [];
  const options = Object.assign(Object.create(null), {
    progress: () => originalProgress.push('original'),
  });
  let received;
  const observer = createPanelActionObserver({
    signal: mount.signal,
    onObservation: (e) => events.push(e),
    runAction(name, args, opts) {
      received = opts;
      return d.promise;
    },
  });
  const promise = observer.runAction('pending', {}, options);
  assert.equal(Object.getPrototypeOf(received), null);
  mount.abort();
  assert.equal(observer.pendingCount, 0);
  assert.equal(events.at(-1).type, 'ownership-retired');
  const count = events.length;
  received.progress({ step: 'late' });
  d.resolve('done');
  assert.equal(await promise, 'done');
  assert.deepEqual(originalProgress, ['original']);
  assert.equal(events.length, count);
  assert.equal(getEventListeners(mount.signal, 'abort').length, 0);
});

test('omitted and explicit undefined options keep original arity and values', () => {
  const calls = [];
  const observer = createPanelActionObserver({
    runAction: function (...args) {
      calls.push(args);
      return 1;
    },
  });
  assert.equal(observer.runAction('omitted', {}), 1);
  assert.equal(observer.runAction('explicit', {}, undefined), 1);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[1].length, 3);
  assert.equal(calls[0][2], undefined);
  assert.equal(calls[1][2], undefined);
});

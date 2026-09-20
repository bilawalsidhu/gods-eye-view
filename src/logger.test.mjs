// gevLogger — level gate, exact console format, and the bounded ring buffer
// (PLAN.md Batch 4d: hot-path modules migrate onto this surface).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOG_LEVELS,
  LOG_RING_CAPACITY,
  drainLogBuffer,
  getLogLevel,
  initialLogLevel,
  logDebug,
  logError,
  logInfo,
  logWarn,
  parseLogLevelName,
  peekLogBuffer,
  recordDebugEvent,
  resetLoggerForTest,
  setLogLevel,
} from './logger.js';

/** Capture console calls; restores the originals on restore(). */
function captureConsole() {
  const calls = [];
  const originals = ['log', 'info', 'warn', 'error'].map((method) => {
    const original = console[method];
    console[method] = (...args) => calls.push({ method, args });
    return [method, original];
  });
  return {
    calls,
    restore() {
      for (const [method, original] of originals) console[method] = original;
    },
  };
}

test('level names parse strictly; typos never silence the console', () => {
  assert.equal(parseLogLevelName('DEBUG'), 'debug');
  assert.equal(parseLogLevelName(' warn '), 'warn');
  assert.equal(parseLogLevelName('verbose'), null);
  assert.equal(parseLogLevelName(''), null);
  assert.equal(parseLogLevelName(null), null);
});

test('?log= picks the startup level; absent or bogus keeps log-everything', () => {
  assert.equal(initialLogLevel('?log=warn'), 'warn');
  assert.equal(initialLogLevel('?layer=x&log=error'), 'error');
  assert.equal(initialLogLevel('?log=nonsense'), 'debug');
  assert.equal(initialLogLevel('?layer=x'), 'debug');
  assert.equal(initialLogLevel(''), 'debug');
});

test('the default gate forwards every level and preserves the exact console format', () => {
  resetLoggerForTest();
  assert.equal(getLogLevel(), 'debug');
  const captured = captureConsole();
  try {
    logDebug('Data:Flights', 'Initialized with billboard icons');
    assert.deepEqual(captured.calls[0], {
      method: 'log', // debug maps onto console.log, preserving today's call sites
      args: ['[Data:Flights] Initialized with billboard icons'],
    });
    logInfo('Data:Flights', 'info goes to console.info');
    assert.equal(captured.calls[1].method, 'info');
    // Boot-verification contracts assert the exact `[ns] message` first arg.
    captured.calls.length = 0;
    logWarn('Data:Flights', 'Fetch error:', new TypeError('offline'));
    assert.equal(captured.calls[0].method, 'warn');
    assert.equal(captured.calls[0].args[0], '[Data:Flights] Fetch error:');
    assert.ok(captured.calls[0].args[1] instanceof TypeError);
    captured.calls.length = 0;
    logError('Search', 'Geocoding failed:', new Error('no geocoder'));
    assert.equal(captured.calls[0].method, 'error');
    assert.equal(captured.calls[0].args[0], '[Search] Geocoding failed:');
  } finally {
    captured.restore();
  }
});

test('below-gate levels skip the console but still reach the ring buffer', () => {
  resetLoggerForTest();
  setLogLevel('warn');
  const captured = captureConsole();
  try {
    logDebug('Detection', 'Mode: dense');
    logInfo('Detection', 'whisper');
    logWarn('Detection', 'visible');
    assert.deepEqual(captured.calls, [{
      method: 'warn',
      args: ['[Detection] visible'],
    }]);
    const levels = peekLogBuffer().map((entry) => entry.level);
    assert.deepEqual(levels, ['debug', 'info', 'warn']);
    assert.equal(peekLogBuffer()[0].text, '[Detection] Mode: dense');
  } finally {
    captured.restore();
  }
});

test('setLogLevel rejects unknown names instead of guessing', () => {
  resetLoggerForTest();
  assert.throws(() => setLogLevel('verbose'), /Unknown log level/);
  assert.equal(getLogLevel(), 'debug');
});

test('the ring buffer is bounded, drained, and peek is non-destructive', () => {
  resetLoggerForTest();
  for (let i = 0; i < LOG_RING_CAPACITY + 25; i++) {
    logDebug('Test', `entry ${i}`);
  }
  const peeked = peekLogBuffer();
  assert.equal(peeked.length, LOG_RING_CAPACITY);
  assert.equal(peeked[0].text, '[Test] entry 25', 'oldest entries fall off first');
  assert.equal(peeked.at(-1).text, `[Test] entry ${LOG_RING_CAPACITY + 24}`);
  assert.equal(peekLogBuffer().length, LOG_RING_CAPACITY, 'peek must not drain');
  const drained = drainLogBuffer();
  assert.equal(drained.length, LOG_RING_CAPACITY);
  assert.deepEqual(peekLogBuffer(), []);
});

test('non-string and Error details render into the buffered text, never throw', () => {
  resetLoggerForTest();
  logWarn('Test', 'boom', new Error('kaput'), { cyclic: 'object' });
  const entry = peekLogBuffer()[0];
  assert.match(entry.text, /\[Test\] boom Error: kaput/);
  assert.match(entry.text, /"cyclic":"object"/);
});

test('a detail JSON cannot stringify survives the render as String(part)', () => {
  resetLoggerForTest();
  const captured = captureConsole();
  try {
    const circular = { depth: 1 };
    circular.self = circular; // JSON.stringify throws on the cycle
    assert.doesNotThrow(() => logWarn('Test', 'snapshot', circular),
      'a broken render must never break the caller');
    assert.match(peekLogBuffer()[0].text, /\[Test\] snapshot \[object Object\]/);
    // The console still received the RAW part, not the flattened fallback.
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].args[1], circular);
  } finally {
    captured.restore();
  }
});

test('voice debug events land in the buffer with their sanitized record', () => {
  resetLoggerForTest();
  recordDebugEvent('session.starting', {
    timestamp: '2026-09-13T00:00:00.000Z',
    sessionId: 's-1',
    event: 'session.starting',
    payload: { model: 'gpt-realtime' },
  });
  const [entry] = peekLogBuffer();
  assert.equal(entry.namespace, 'GEV:voice-debug');
  assert.equal(entry.text, 'event=session.starting');
  assert.equal(entry.detail.sessionId, 's-1');
  drainLogBuffer();
});

test('level ordering is monotonic and silent sits above everything', () => {
  assert.ok(LOG_LEVELS.debug < LOG_LEVELS.info);
  assert.ok(LOG_LEVELS.info < LOG_LEVELS.warn);
  assert.ok(LOG_LEVELS.warn < LOG_LEVELS.error);
  assert.ok(LOG_LEVELS.error < LOG_LEVELS.silent);
});

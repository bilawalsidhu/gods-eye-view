import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kiwiPorts,
  kiwiEndpoints,
  createKiwiSession,
  kiwiSocketUrl,
} from './client.js';

const station = {
  id: 'abc12345',
  host: 'rx.example.com',
  port: 8073,
  secure: false,
  lowHz: 0,
  highHz: 30_000_000,
};

const tagged = (tag, body) => {
  const out = new Uint8Array(4 + body.length);
  out.set(
    [...tag].map((c) => c.charCodeAt(0)),
    0,
  );
  out.set(body, 4);
  return out;
};
const msg = (text) => tagged('MSG', new TextEncoder().encode(text));
const snd = (pcm = [0x40, 0x00]) => {
  const body = new Uint8Array(7 + pcm.length);
  body[5] = 0x03;
  body[6] = 0xe8;
  body.set(pcm, 7);
  // No filler byte after "SND" (MSG and W/F have one).
  const out = new Uint8Array(3 + body.length);
  out.set(
    [...'SND'].map((c) => c.charCodeAt(0)),
    0,
  );
  out.set(body, 3);
  return out;
};

function harness(options = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      this.closed = false;
      sockets.push(this);
    }
    send(text) {
      this.sent.push(text);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    receive(data) {
      this.onmessage?.({ data: data.buffer ?? data });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.({ code: 1006, reason: '' });
    }
  }
  const timers = [];
  const session = createKiwiSession({
    station,
    WebSocketImpl: FakeSocket,
    now: () => 1000,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    startKhz: 7200,
    ...options,
  });
  const events = [];
  for (const name of [
    'state',
    'audio',
    'smeter',
    'waterfall',
    'error',
    'waterfallLost',
    'view',
    'diag',
  ])
    session.on(name, (p) => events.push([name, p]));
  return { session, sockets, timers, events };
}

test('builds ws urls, with a legacy fallback form', () => {
  assert.equal(
    kiwiSocketUrl(station, 'SND', 5),
    'ws://rx.example.com:8073/kiwi/5/SND',
  );
  assert.equal(
    kiwiSocketUrl(station, 'W/F', 5, true),
    'ws://rx.example.com:8073/5/W/F',
  );
  assert.equal(
    kiwiSocketUrl({ ...station, secure: true }, 'SND', 5),
    'wss://rx.example.com:8073/kiwi/5/SND',
  );
});

test('handshake: authenticates on open, then waits for the receiver before setup', () => {
  const { session, sockets } = harness();
  session.start();
  assert.equal(sockets.length, 2);
  const [sndSocket, wfSocket] = sockets;
  assert.match(sndSocket.url, /\/kiwi\/\d+\/SND$/);
  assert.match(wfSocket.url, /\/kiwi\/\d+\/W\/F$/);
  sndSocket.open();
  assert.equal(sndSocket.sent[0], 'SET auth t=kiwi p=#');
  assert.equal(
    sndSocket.sent.length,
    2,
    'only auth + ident before the receiver is ready',
  );
  sndSocket.receive(msg('audio_rate=12000'));
  assert.deepEqual(sndSocket.sent.at(-1), 'SET AR OK in=12000 out=44100');
  sndSocket.receive(msg('sample_rate=12000.000'));
  assert.ok(sndSocket.sent.includes('SET compression=0'));
  assert.ok(
    sndSocket.sent.includes(
      'SET mod=am low_cut=-4500 high_cut=4500 freq=7200.000',
    ),
  );
  assert.equal(sndSocket.sent.at(-1), 'SET keepalive');
  wfSocket.open();
  assert.equal(wfSocket.sent[0], 'SET auth t=kiwi p=#');
  assert.ok(!wfSocket.sent.includes('SET wf_comp=0'));
  wfSocket.receive(msg('wf_setup'));
  assert.ok(wfSocket.sent.includes('SET wf_comp=0'));
  assert.ok(wfSocket.sent.includes('SET zoom=0 cf=15000.000'));
});

test("uses the receiver's own audio rate for AR OK and playback", () => {
  const { session, sockets, events } = harness();
  session.start();
  sockets[0].open();
  sockets[0].receive(msg('audio_rate=12001'));
  assert.equal(sockets[0].sent.at(-1), 'SET AR OK in=12001 out=44100');
  sockets[0].receive(msg('sample_rate=12001.000'));
  sockets[0].receive(snd());
  assert.equal(events.find(([n]) => n === 'audio')[1].rate, 12001);
});

test('starts anyway if the receiver never announces readiness', () => {
  const delayed = [];
  const { session, sockets } = harness({
    setTimeoutImpl: (fn, ms) => (delayed.push([fn, ms]), delayed.length),
  });
  session.start();
  sockets[0].open();
  sockets[1].open();
  assert.ok(!sockets[0].sent.includes('SET compression=0'));
  for (const [fn, ms] of delayed) if (ms === 3000) fn();
  assert.ok(sockets[0].sent.includes('SET AR OK in=12000 out=44100'));
  assert.ok(sockets[0].sent.includes('SET compression=0'));
  assert.ok(sockets[1].sent.includes('SET wf_comp=0'));
});

test('audio frames go live and surface samples and s-meter', () => {
  const { session, sockets, events } = harness();
  session.start();
  sockets[0].open();
  sockets[0].receive(snd());
  assert.equal(session.state, 'live');
  const audio = events.find(([n]) => n === 'audio')[1];
  assert.deepEqual([...audio.samples], [0.5]);
  assert.equal(audio.rate, 12000);
  assert.ok(Math.abs(events.find(([n]) => n === 'smeter')[1].dbm - -27) < 1e-9);
});

test('waterfall frames carry bins and view', () => {
  const { session, sockets, events } = harness();
  session.start();
  sockets[1].open();
  const body = new Uint8Array(12 + 4);
  body.set([200, 201, 202, 203], 12);
  sockets[1].receive(tagged('W/F', body));
  const wf = events.find(([n]) => n === 'waterfall')[1];
  assert.equal(wf.bins.length, 4);
  assert.equal(wf.view.zoom, 0);
});

test('tuning sends a SET and picks a sensible mode until the user pins one', () => {
  const { session, sockets } = harness();
  session.start();
  sockets[0].open();
  sockets[0].receive(msg('sample_rate=12000.000'));
  session.tune({ freqKhz: 14074 });
  assert.equal(
    sockets[0].sent.at(-1),
    'SET mod=usb low_cut=300 high_cut=2700 freq=14074.000',
  );
  session.tune({ mode: 'cw' });
  session.tune({ freqKhz: 810 });
  assert.match(sockets[0].sent.at(-1), /^SET mod=cw .* freq=810\.000$/);
  session.tune({ freqKhz: 999999 });
  assert.match(sockets[0].sent.at(-1), /freq=30000\.000$/);
});

test('zoom re-centres the waterfall on the tuned frequency', () => {
  const { session, sockets } = harness();
  session.start();
  sockets[1].open();
  sockets[1].receive(msg('wf_setup'));
  session.setZoom(4);
  assert.equal(
    sockets[1].sent.at(-1),
    'SET zoom=4 cf=7200.000'.replace('7200', '7200'),
  );
  session.setZoom(0);
  assert.equal(sockets[1].sent.at(-1), 'SET zoom=0 cf=15000.000');
});

test('a "too busy" message is a clean fatal error', () => {
  const { session, sockets, events } = harness();
  session.start();
  sockets[0].open();
  sockets[0].receive(msg('too_busy=4'));
  assert.equal(session.state, 'error');
  assert.match(events.find(([n]) => n === 'error')[1].message, /slots/);
  assert.ok(sockets.every((s) => s.closed));
});

test('falls back to the legacy path when the first attempt dies unopened', () => {
  const { session, sockets } = harness();
  session.start();
  sockets[0].drop();
  const retry = sockets.at(-1);
  assert.match(retry.url, /\/\d+\/SND$/);
  assert.doesNotMatch(retry.url, /\/kiwi\//);
});

test('a dead waterfall keeps the audio alive', () => {
  const { session, sockets, events } = harness();
  session.start();
  sockets[0].open();
  sockets[1].open();
  sockets[1].drop();
  assert.ok(events.some(([n]) => n === 'waterfallLost'));
  assert.notEqual(session.state, 'error');
});

test('a dropped audio socket ends the session; close is idempotent', () => {
  const { session, sockets } = harness();
  session.start();
  sockets[0].open();
  sockets[0].drop();
  assert.equal(session.state, 'error');
  session.close();
  session.close();
});

test('a refused connection reports which paths were tried and how it closed', () => {
  let clock = 1000;
  const { session, sockets, events } = harness({ now: () => clock });
  session.start();
  clock = 1400;
  sockets[0].drop(); // /kiwi path refused -> legacy retry
  const legacy = sockets.find(
    (s) => !s.url.includes('/kiwi/') && s.url.endsWith('/SND'),
  );
  assert.ok(legacy, 'retried on the legacy path');
  clock = 1900;
  legacy.drop();
  const diags = events.filter(([n]) => n === 'diag').map(([, p]) => p);
  assert.equal(diags.length, 2);
  assert.deepEqual(diags[0], {
    stream: 'SND',
    host: 'rx.example.com',
    port: 8073,
    legacy: false,
    opened: false,
    code: 1006,
    reason: '',
    elapsedMs: 400,
  });
  assert.equal(diags[1].legacy, true);
  assert.equal(session.state, 'error');
});

test('keepalive pings both sockets', () => {
  const { session, sockets, timers } = harness();
  session.start();
  sockets[0].open();
  sockets[1].open();
  timers[0]();
  assert.equal(sockets[0].sent.at(-1), 'SET keepalive');
  assert.equal(sockets[1].sent.at(-1), 'SET keepalive');
});

test('a receiver that really stops sending audio is reported after the stall window', () => {
  let clock = 1000;
  const { session, sockets, timers, events } = harness({ now: () => clock });
  session.start();
  sockets[0].open();
  sockets[0].receive(snd());
  assert.equal(session.state, 'live');
  // Regular 5 s ticks, no further audio: still within the 15 s window.
  for (const t of [6000, 11000, 16000]) {
    clock = t;
    timers[0]();
  }
  assert.equal(session.state, 'live');
  clock = 21000;
  timers[0]();
  assert.equal(session.state, 'error');
  assert.match(
    events.find(([n]) => n === 'error')[1].message,
    /stopped sending audio/,
  );
});

test('a starved page is not mistaken for a dead receiver', () => {
  let clock = 1000;
  const { session, sockets, timers, events } = harness({ now: () => clock });
  session.start();
  sockets[0].open();
  sockets[0].receive(snd());
  // The page was blocked for a minute: the timer fires long after it was due,
  // before the queued audio frames have been read.
  clock = 61_000;
  timers[0]();
  assert.equal(session.state, 'live');
  assert.equal(
    events.some(([n]) => n === 'error'),
    false,
  );
  // Counting starts afresh from that tick, so a prompt next tick is also fine...
  clock = 66_000;
  timers[0]();
  assert.equal(session.state, 'live');
  // ...but a receiver that then stays silent is still caught.
  for (const t of [71_000, 76_000, 81_000]) {
    clock = t;
    timers[0]();
  }
  assert.equal(session.state, 'error');
});

test('proxy-listed receivers on port 80 go straight to 8073 (port 80 only redirects)', () => {
  const proxied = { ...station, host: 'ei2hh.proxy.kiwisdr.com', port: 80 };
  assert.deepEqual(kiwiPorts(proxied), [8073, 8073]);
  assert.equal(
    kiwiSocketUrl(proxied, 'SND', 5, false, 8073),
    'ws://ei2hh.proxy.kiwisdr.com:8073/kiwi/5/SND',
  );
  assert.deepEqual(kiwiPorts({ ...station, port: 80 }), [80, 8073]);
  assert.deepEqual(kiwiPorts({ ...station, port: 8073 }), [8073]);
  assert.deepEqual(kiwiPorts({ ...station, port: 80, secure: true }), [80]);
});

test('a bare-port receiver falls back to 8073 after both paths fail on port 80', () => {
  const { session, sockets } = harness({ station: { ...station, port: 80 } });
  session.start();
  sockets[0].drop();
  sockets
    .find(
      (s) =>
        s.url.startsWith('ws://rx.example.com/') &&
        !s.url.includes('/kiwi/') &&
        s.url.endsWith('/SND'),
    )
    .drop();
  assert.ok(
    sockets.some(
      (s) =>
        s.url.startsWith('ws://rx.example.com:8073/kiwi/') &&
        s.url.endsWith('/SND'),
    ),
  );
});

test('audio and waterfall sockets share one timestamp, even when the clock ticks', () => {
  let clock = 5000;
  const { session, sockets } = harness({ now: () => clock++ });
  session.start();
  const stamps = sockets.map((s) => /\/(\d+)\/(SND|W\/F)$/.exec(s.url)[1]);
  assert.equal(stamps.length, 2);
  assert.equal(stamps[0], stamps[1]);
});

test('a receiver behind the secondary proxy is tried on proxy2 after the primary refuses', () => {
  const proxied = { ...station, host: '21263.proxy.kiwisdr.com', port: 80 };
  assert.deepEqual(kiwiEndpoints(proxied), [
    { host: '21263.proxy.kiwisdr.com', port: 8073 },
    { host: '21263.proxy2.kiwisdr.com', port: 8073 },
  ]);
  const { session, sockets } = harness({ station: proxied });
  session.start();
  const sndTry = () => sockets.filter((s) => s.url.endsWith('/SND')).at(-1);
  sndTry().drop(); // primary kiwi path
  sndTry().drop(); // primary legacy path
  assert.equal(
    sndTry().url.replace(/\d+\/SND$/, 'N/SND'),
    'ws://21263.proxy2.kiwisdr.com:8073/kiwi/N/SND',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createNarrationScheduler } from './narration.js';

function rig({ canSpeak = () => true, earconAvailable = true } = {}) {
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  const spoken = [];
  const events = [];
  let retracted = 0;
  const earcon = {
    on: false,
    available: () => earconAvailable,
    start() {
      this.on = true;
      events.push('earcon:start');
    },
    stop() {
      this.on = false;
      events.push('earcon:stop');
    },
  };
  const scheduler = createNarrationScheduler({
    speak: (line) => {
      spoken.push({ line, at: clock });
      return true;
    },
    retract: () => {
      retracted++;
    },
    earcon,
    canSpeak: () => canSpeak(),
    onNarration: (kind) => events.push(kind),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    const target = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = target;
  };
  return { scheduler, spoken, events, earcon, advance, timers, retracted: () => retracted };
}

test('a fast tool (<700 ms) is never narrated and never earconned', () => {
  const r = rig();
  r.scheduler.userTurnEnded();
  r.scheduler.toolStarted('a', { name: 'set_layer_visibility', label: 'Flights' });
  r.advance(400);
  r.scheduler.toolFinished('a');
  r.scheduler.audible();
  r.advance(20000);
  assert.deepEqual(r.spoken, []);
  assert.equal(r.events.includes('earcon:start'), false);
});

test('a slow tool gets the earcon at 700 ms and its current step spoken at 1.5 s', () => {
  const r = rig();
  r.scheduler.userTurnEnded();
  r.scheduler.toolStarted('a', { name: 'annotate_map', label: 'Texas Capitol' });
  r.scheduler.progress('a', { step: 'resolve', label: 'Texas Capitol' });
  r.advance(699);
  assert.equal(r.earcon.on, false);
  r.advance(1);
  assert.equal(r.earcon.on, true);
  r.advance(800);
  assert.deepEqual(r.spoken.map((s) => s.line), ['Finding Texas Capitol on the map.']);
  assert.equal(r.spoken[0].at, 1500);
  assert.equal(r.earcon.on, false, 'speech replaces the earcon');
});

test('a spoken preamble suppresses step lines but keeps one still-working line', () => {
  const r = rig();
  r.scheduler.userTurnEnded();
  r.scheduler.preamble();
  r.scheduler.toolStarted('a', { name: 'select_nearest_aircraft', label: 'Austin' });
  r.scheduler.progress('a', { step: 'layer', label: 'flights' });
  r.advance(5000);
  r.scheduler.progress('a', { step: 'fly', label: 'Austin' });
  r.advance(3000);
  assert.deepEqual(r.spoken.map((s) => s.line), ['Still working on Austin.']);
  r.advance(30000);
  assert.equal(r.spoken.length, 1);
});

test('step changes speak at most twice, at least 3 s apart', () => {
  const r = rig();
  r.scheduler.userTurnEnded();
  r.scheduler.toolStarted('a', { name: 'select_nearest_aircraft', label: 'Austin' });
  r.scheduler.progress('a', { step: 'layer', label: 'flights' });
  r.advance(1500);
  r.scheduler.progress('a', { step: 'fly', label: 'Austin' });
  r.advance(1000);
  assert.equal(r.spoken.length, 1, 'second line waits for the 3 s gap');
  r.advance(2000);
  r.scheduler.progress('a', { step: 'refresh' });
  r.advance(3500);
  const lines = r.spoken.map((s) => s.line);
  assert.deepEqual(lines.slice(0, 2), ['Turning on flights.', 'Heading to Austin.']);
  assert.equal(r.spoken[1].at, 4500);
  assert.ok(!lines.includes('Loading aircraft there.'), 'third step line is capped');
});

test('no progress line speaks after the tool result, and an unheard line is retracted', () => {
  const r = rig();
  r.scheduler.userTurnEnded();
  r.scheduler.toolStarted('a', { name: 'annotate_map', label: 'Presidio' });
  r.scheduler.progress('a', { step: 'resolve', label: 'Presidio' });
  r.advance(1400);
  r.scheduler.toolFinished('a');
  assert.equal(r.retracted(), 1);
  r.advance(20000);
  assert.deepEqual(r.spoken, []);
  assert.equal(r.earcon.on, false, 'the earcon ends within the reply grace');
});

test('cancellation (barge-in) drops every pending line and the earcon', () => {
  const r = rig();
  r.scheduler.userTurnEnded();
  r.scheduler.toolStarted('a', { name: 'fly_to_location', label: 'Tokyo' });
  r.scheduler.progress('a', { step: 'search', label: 'Tokyo' });
  r.advance(900);
  assert.equal(r.earcon.on, true);
  r.scheduler.cancel();
  assert.equal(r.earcon.on, false);
  r.advance(20000);
  assert.deepEqual(r.spoken, []);
  assert.equal(r.scheduler.state().pendingTimers, 0);
});

test('lines wait while speaking is not allowed and silent tools stay silent', () => {
  let allowed = false;
  const r = rig({ canSpeak: () => allowed });
  r.scheduler.userTurnEnded();
  r.scheduler.toolStarted('radio', { name: 'control_radio', narrate: false });
  r.scheduler.toolStarted('a', { name: 'annotate_map', label: 'Zilker Park' });
  r.scheduler.progress('a', { step: 'resolve', label: 'Zilker Park' });
  r.advance(1500);
  assert.deepEqual(r.spoken, [], 'user holding push-to-talk: no line');
  allowed = true;
  r.advance(7000);
  assert.deepEqual(r.spoken.map((s) => s.line), ['Still working on Zilker Park.']);
});

test('the earcon only plays when its output cannot reach the microphone', () => {
  const r = rig({ earconAvailable: false });
  r.scheduler.userTurnEnded();
  r.scheduler.toolStarted('a', { name: 'annotate_map', label: 'X' });
  r.advance(1000);
  assert.equal(r.events.includes('earcon:start'), false);
});

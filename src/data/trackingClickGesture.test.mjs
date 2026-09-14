import { readSource } from '../testSupport/readSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindTrackingClickGesture,
  domEventPressClock,
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';
import { TRACKED_MODEL_MAX_PX as CIVIL_TRACKED_MODEL_MAX_PX } from './flights.js';
import { TRACKED_MODEL_MAX_PX as MILITARY_TRACKED_MODEL_MAX_PX } from './militaryFlights.js';

const TYPES = {
  LEFT_DOWN: 'left-down',
  MOUSE_MOVE: 'mouse-move',
  LEFT_UP: 'left-up',
  LEFT_CLICK: 'left-click',
};

function makeHandler() {
  const actions = new Map();
  return {
    setInputAction(callback, type) { actions.set(type, callback); },
    fire(type, event) { actions.get(type)?.(event); },
  };
}

test('tracking click discrimination pins the travel/duration boundary matrix', () => {
  const matrix = [
    [{ travelPx: 0, durationMs: 0 }, true],
    [{ travelPx: 6, durationMs: 400 }, true],
    [{ travelPx: 6.001, durationMs: 400 }, false],
    [{ travelPx: 6, durationMs: 400.001 }, false],
    [{ travelPx: 20, durationMs: 50 }, false],
    [{ travelPx: 0, durationMs: 1000 }, false],
  ];
  for (const [gesture, expected] of matrix) {
    assert.equal(isTrackingClickGesture(gesture), expected, JSON.stringify(gesture));
  }
  assert.equal(isTrackingSelectionGesture({ travelPx: 0, durationMs: 1000 }), true);
  assert.equal(isTrackingSelectionGesture({ travelPx: 6.001, durationMs: 10 }), false);
});

test('synthetic drag-then-click sequence does not reach the untrack callback', () => {
  let timeMs = 0;
  let untrackCalls = 0;
  const handler = makeHandler();
  bindTrackingClickGesture(handler, (_click, gesture) => {
    if (isTrackingClickGesture(gesture)) untrackCalls += 1;
  }, {
    now: () => timeMs,
    eventTypes: TYPES,
  });

  handler.fire(TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  timeMs = 20;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 14, y: 10 } });
  timeMs = 40;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 10, y: 10 } });
  timeMs = 60;
  handler.fire(TYPES.LEFT_UP, { position: { x: 10, y: 10 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });

  assert.equal(untrackCalls, 0, '8 px accumulated travel must suppress the click despite zero displacement');

  handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });
  assert.equal(untrackCalls, 1, 'suppression is consumed and cannot poison the next click');
});

test('slow clean sprite clicks select, while long presses and orbit nudges cannot untrack', () => {
  let timeMs = 0;
  let selections = 0;
  let untracks = 0;
  const handler = makeHandler();
  bindTrackingClickGesture(handler, (click, gesture) => {
    if (!isTrackingSelectionGesture(gesture)) return;
    if (click.sprite) {
      selections += 1;
      return;
    }
    if (isTrackingClickGesture(gesture)) untracks += 1;
  }, {
    now: () => timeMs,
    eventTypes: TYPES,
  });

  handler.fire(TYPES.LEFT_DOWN, { position: { x: 0, y: 0 } });
  timeMs = 401;
  handler.fire(TYPES.LEFT_UP, { position: { x: 0, y: 0 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 0, y: 0 }, sprite: true });
  assert.equal(selections, 1, 'duration alone must not suppress entity selection');
  assert.equal(untracks, 0);

  timeMs = 500;
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  timeMs = 520;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 14, y: 10 } });
  timeMs = 540;
  handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 10, y: 10 } });
  handler.fire(TYPES.LEFT_UP, { position: { x: 10, y: 10 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });
  assert.equal(untracks, 0, 'return-to-origin orbit travel must not untrack');

  timeMs = 600;
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 0, y: 0 } });
  timeMs = 750;
  handler.fire(TYPES.LEFT_UP, { position: { x: 3, y: 4 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 3, y: 4 } });
  assert.equal(untracks, 1, 'a short clean empty-space tap still untracks');
});

test('civilian and military click handlers apply duration only at the deselect branch', () => {
  const sources = [
    readSource('./flights.js', import.meta.url),
    readSource('./militaryFlights.js', import.meta.url),
  ];
  for (const source of sources) {
    assert.match(source, /isTrackingSelectionGesture\(gesture\)[\s\S]+scene\.pick/);
    assert.match(source, /isTrackingClickGesture\(gesture\)[\s\S]+_clearTracking\([^)]*\{ origin: 'user' \}\)/);
  }
  assert.doesNotMatch(
    sources[0],
    /_trackedEntity = _viewer\.entities\.add\(\{\s*id:/,
    'civilian tracked entities must retain Cesium-generated GUIDs',
  );
});

test('civilian and military tracked model caps both expose the selected 200 px feel', () => {
  assert.equal(CIVIL_TRACKED_MODEL_MAX_PX, 200);
  assert.equal(MILITARY_TRACKED_MODEL_MAX_PX, 200);
});

function makeDomElement() {
  const listeners = new Map();
  const list = (type) => {
    if (!listeners.has(type)) listeners.set(type, []);
    return listeners.get(type);
  };
  return {
    addEventListener(type, fn) { list(type).push(fn); },
    removeEventListener(type, fn) {
      const all = list(type);
      const i = all.indexOf(fn);
      if (i >= 0) all.splice(i, 1);
    },
    fireDom(type, event) { for (const fn of [...list(type)]) fn(event); },
    listenerCount(type) { return list(type).length; },
  };
}

test('DOM press clock measures physical press time, not handler-processing time', () => {
  const element = makeDomElement();
  const clock = domEventPressClock(element);
  const handler = makeHandler();
  let deselects = 0;
  bindTrackingClickGesture(handler, (_click, gesture) => {
    if (isTrackingClickGesture(gesture)) deselects += 1;
  }, {
    now: clock.now,
    eventTypes: TYPES,
  });

  const base = Math.round(performance.now());
  // A 20 ms physical tap (DOM stamps base -> base+20) delivered while the
  // main thread is responsive — the classic case: duration equals the true
  // press length, and the full click classifier passes it.
  element.fireDom('mousedown', { timeStamp: base });
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  element.fireDom('mouseup', { timeStamp: base + 20 });
  handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
  assert.equal(deselects, 1, 'an instant tap must pass the duration gate');

  // The stale up-stamp from press 1 must not poison press 2's start time.
  element.fireDom('mousedown', { timeStamp: base + 5000 });
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  element.fireDom('mouseup', { timeStamp: base + 5015 });
  handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
  assert.equal(deselects, 2, 'each press must be measured from its own mousedown stamp');

  // A genuine long press (900 ms hold) is still rejected — the gate's
  // original purpose is preserved; only queue latency stopped counting.
  element.fireDom('mousedown', { timeStamp: base + 8000 });
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  element.fireDom('mouseup', { timeStamp: base + 8900 });
  handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
  assert.equal(deselects, 2, 'a real long press must not deselect');

  clock.dispose();
  assert.equal(element.listenerCount('mousedown'), 0, 'dispose removes the DOM listeners');
  assert.equal(element.listenerCount('mouseup'), 0, 'dispose removes the DOM listeners');
});

test('clock binds pointer events when available and never mixes families', () => {
  // Cesium's handler pipeline is pointer-based, and CDP-driven headless
  // Chrome generates NO compatibility mousedown/mouseup — a mouse-bound
  // clock silently degenerates to wall-clock handler time and eats every
  // click. Where PointerEvent exists, stamps must come from pointerdown/
  // pointerup and the mouse listeners must not be bound at all.
  const element = makeDomElement();
  const realWindow = globalThis.window;
  const realPointerEvent = globalThis.PointerEvent;
  globalThis.window = globalThis;
  globalThis.PointerEvent = function PointerEvent() {};
  try {
    const clock = domEventPressClock(element);
    assert.equal(element.listenerCount('pointerdown'), 1, 'pointer clock binds pointerdown');
    assert.equal(element.listenerCount('pointerup'), 1, 'pointer clock binds pointerup');
    assert.equal(element.listenerCount('pointercancel'), 1, 'pointer clock ends presses on pointercancel');
    assert.equal(element.listenerCount('mousedown'), 0, 'mouse listeners must not coexist with pointer ones');
    assert.equal(element.listenerCount('mouseup'), 0, 'mouse listeners must not coexist with pointer ones');

    const handler = makeHandler();
    let lastGesture = null;
    bindTrackingClickGesture(handler, (_click, gesture) => { lastGesture = gesture; }, {
      now: clock.now,
      eventTypes: TYPES,
    });

    // The headless shape: both pointer events carry the SAME creation stamp
    // (frame-quantized instant tap) but listeners run seconds later.
    const base = Math.round(performance.now());
    element.fireDom('pointerdown', { timeStamp: base });
    handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
    element.fireDom('pointerup', { timeStamp: base });
    handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
    handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
    assert.equal(lastGesture.durationMs, 0, 'a quantized instant press reads as instant');

    // pointercancel ends a press without a pointerup; the next press must
    // still measure from its own pointerdown stamp.
    element.fireDom('pointerdown', { timeStamp: base + 1000 });
    handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
    element.fireDom('pointercancel', { timeStamp: base + 1400 });
    element.fireDom('pointerdown', { timeStamp: base + 5000 });
    handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
    element.fireDom('pointerup', { timeStamp: base + 5100 });
    handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
    handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
    assert.equal(lastGesture.durationMs > 0 && lastGesture.durationMs <= 400, true,
      'a post-cancel press measures from its own pointerdown stamp');

    clock.dispose();
    assert.equal(element.listenerCount('pointerdown'), 0, 'dispose removes the pointer listeners');
    assert.equal(element.listenerCount('pointerup'), 0, 'dispose removes the pointer listeners');
    assert.equal(element.listenerCount('pointercancel'), 0, 'dispose removes the pointercancel listener');
  } finally {
    if (realPointerEvent === undefined) delete globalThis.PointerEvent;
    else globalThis.PointerEvent = realPointerEvent;
    globalThis.window = realWindow;
  }
});

test('quantization floor forgives bursts, disables past half-window frames, recovers', () => {
  const element = makeDomElement();
  let rafCallback = null;
  const rafHandle = 1;
  const realWindow = globalThis.window;
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = (cb) => { rafCallback = cb; return rafHandle; };
  globalThis.cancelAnimationFrame = () => { rafCallback = null; };
  try {
    const clock = domEventPressClock(element);
    const handler = makeHandler();
    const gestures = [];
    bindTrackingClickGesture(handler, (_click, gesture) => {
      gestures.push(gesture);
    }, { now: clock.now, eventTypes: TYPES });
    const press = (downOffset, upOffset) => {
      const base = Math.round(performance.now());
      element.fireDom('mousedown', { timeStamp: base + downOffset });
      handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
      element.fireDom('mouseup', { timeStamp: base + upOffset });
      handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
      handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
    };

    // Steady 16 ms cadence warms the recent peak to 16 → floor 32.
    let t = 1000;
    for (let i = 0; i < 6; i += 1) { t += 16; rafCallback?.(t); }
    press(0, 50);
    assert.equal(Math.round(gestures[0].durationMs), 18, 'floor = 2×16 ms leaves the true 50 ms press');

    // A burst frame (2 s gap): peak 2000 ≥ half the click window, so
    // sub-window durations are unmeasurable BY CONSTRUCTION — rAF cadence
    // and input-dispatch quantization are different pipelines and diverge
    // under load, so no frame-derived floor can bound the stamp gap. Every
    // press reads instant and travel remains the only enforceable gate —
    // including the long holds that would otherwise look like duration
    // signal on a machine that cannot measure them.
    t += 2000;
    rafCallback?.(t);
    press(0, 1500);
    assert.equal(gestures[1].durationMs, 0, 'a burst-quantized press must read as instant');
    press(0, 4500);
    assert.equal(gestures[2].durationMs, 0, 'holds are equally unmeasurable past the threshold');

    // The gate is not permanently disabled: once the machine's cadence
    // RECOVERS (sustained healthy 16 ms frames spanning ~5τ of virtual
    // time), the burst memory decays and the gate regains discrimination.
    for (let i = 0; i < 9400; i += 1) { t += 16; rafCallback?.(t); }
    press(0, 300);
    assert.equal(gestures[3].durationMs > 150, true, 'recovered floor must stop forgiving ordinary gaps');
    assert.equal(gestures[3].durationMs <= 400, true);
    press(0, 900);
    assert.equal(gestures[4].durationMs > 400, true, 'a 900 ms hold must be rejected after recovery');

    // Moderate load (peak 100 ms < the 200 ms threshold) keeps the gate
    // live with burst forgiveness: floor 200 leaves a 500 ms hold
    // classifiable as a hold while short taps stay clean.
    for (let i = 0; i < 40; i += 1) { t += 100; rafCallback?.(t); }
    press(0, 120);
    assert.equal(gestures[5].durationMs, 0, 'moderate-load quantized taps read as instant');
    press(0, 500);
    assert.equal(gestures[6].durationMs > 200, true, 'moderate load still discriminates real holds');

    clock.dispose();
    assert.equal(rafCallback, null, 'dispose cancels the cadence sampler');
  } finally {
    globalThis.window = realWindow;
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
  }
});

test('learned tap quantization baseline forgives pipeline-explained press gaps', () => {
  const element = makeDomElement();
  let rafCallback = null;
  const rafHandle = 1;
  const realWindow = globalThis.window;
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = (cb) => { rafCallback = cb; return rafHandle; };
  globalThis.cancelAnimationFrame = () => { rafCallback = null; };
  try {
    const clock = domEventPressClock(element);
    const handler = makeHandler();
    const gestures = [];
    bindTrackingClickGesture(handler, (_click, gesture) => {
      gestures.push(gesture);
    }, { now: clock.now, eventTypes: TYPES });
    const press = (downOffset, upOffset) => {
      const base = Math.round(performance.now());
      element.fireDom('mousedown', { timeStamp: base + downOffset });
      handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
      element.fireDom('mouseup', { timeStamp: base + upOffset });
      handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
      handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
    };

    // Healthy-looking 16 ms frames (the input pipeline is the thing that is
    // slow — its stamps straddle frames the sampler cannot see).
    let t = 1000;
    for (let i = 0; i < 6; i += 1) { t += 16; rafCallback?.(t); }

    // First press on a machine whose input pipeline quantizes instant taps
    // to ~600 ms: the frame-derived floor (32 ms) is all the clock knows, so
    // the gap reads mostly raw — one click is spent LEARNING the baseline.
    press(0, 600);
    assert.equal(gestures[0].durationMs > 400, true, 'bootstrap press measures against the frame floor only');

    // The learned baseline (600 ms ≥ the click window) disables duration
    // enforcement BY CONSTRUCTION: taps and holds quantize identically at
    // this level, so nothing duration-shaped is expressible and travel
    // remains the only gate.
    press(0, 650);
    assert.equal(gestures[1].durationMs, 0, 'a repeat quantized tap must read as instant');
    press(0, 2600);
    assert.equal(gestures[2].durationMs, 0, 'holds are equally unmeasurable at this quantization');

    // After the cadence recovers (~5τ of healthy frames decays the learned
    // baseline), the gate re-arms: ordinary taps read near-true and a real
    // hold is rejected on its own merits again.
    for (let i = 0; i < 9400; i += 1) { t += 16; rafCallback?.(t); }
    press(0, 300);
    assert.equal(gestures[3].durationMs > 150, true, 'recovered baseline must stop forgiving ordinary gaps');
    press(0, 900);
    assert.equal(gestures[4].durationMs > 400, true, 'a 900 ms hold must be rejected after recovery');

    clock.dispose();
  } finally {
    globalThis.window = realWindow;
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCaf;
  }
});

test('presses queued past the click window read as instant so loaded machines keep clicks', () => {
  const element = makeDomElement();
  const clock = domEventPressClock(element);
  const handler = makeHandler();
  let lastGesture = null;
  let deselects = 0;
  bindTrackingClickGesture(handler, (_click, gesture) => {
    lastGesture = gesture;
    if (isTrackingClickGesture(gesture)) deselects += 1;
  }, {
    now: clock.now,
    eventTypes: TYPES,
  });

  // Both DOM events queue past the click window (each stamped >400 ms before
  // the main thread dispatches it): the stamp gap reflects frame cadence, not
  // press duration, so the clock reports an instant press and the travel gate
  // alone decides. Refusing to guess keeps empty-space deselect working on a
  // saturated main thread instead of silently eating every click.
  const base = Math.round(performance.now());
  element.fireDom('mousedown', { timeStamp: base - 600 });
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  element.fireDom('mouseup', { timeStamp: base - 550 });
  handler.fire(TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 5, y: 5 } });
  assert.equal(lastGesture.durationMs, 0, 'an unmeasurable press must report as instant');
  assert.equal(deselects, 1, 'travel remains the only enforceable gate when duration is unmeasurable');

  clock.dispose();
});

test('DOM press clock falls back to wall-clock time when no stamps are available', () => {
  // Synthetic touch sequences deliver no mousedown/mouseup stamps; the clock
  // must still produce finite, monotonic-enough times so durationMs stays a
  // real number (never Infinity, never NaN).
  const clock = domEventPressClock(null);
  const t0 = clock.now();
  assert.equal(Number.isFinite(t0), true);
  const handler = makeHandler();
  let lastGesture = null;
  bindTrackingClickGesture(handler, (_click, gesture) => { lastGesture = gesture; }, {
    now: clock.now,
    eventTypes: TYPES,
  });
  handler.fire(TYPES.LEFT_DOWN, { position: { x: 0, y: 0 } });
  handler.fire(TYPES.LEFT_UP, { position: { x: 0, y: 0 } });
  handler.fire(TYPES.LEFT_CLICK, { position: { x: 0, y: 0 } });
  assert.equal(Number.isFinite(lastGesture.durationMs), true, 'duration must stay finite without DOM stamps');
  assert.equal(lastGesture.durationMs >= 0, true);
  clock.dispose();
});

test('production gesture bindings measure press duration from DOM event stamps', () => {
  const sources = {
    'cctv.js': readSource('./cctv.js', import.meta.url),
    'flights.js': readSource('./flights.js', import.meta.url),
    'militaryFlights.js': readSource('./militaryFlights.js', import.meta.url),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /domEventPressClock\(/, `${name} must create a DOM press clock`);
    assert.match(source, /now: _clickPressClock\.now/, `${name} must feed the clock to its click gesture`);
    assert.match(source, /_clickPressClock\?\.dispose\(\)/, `${name} must dispose the clock with its click handler`);
  }
});

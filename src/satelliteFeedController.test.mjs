import assert from 'node:assert/strict';
import test from 'node:test';
import { SatelliteFeedController } from './satelliteFeedController.js';

/** Minimal synchronous event target with the two events the controller wants. */
function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    emit: (type, detail) => {
      for (const fn of listeners.get(type) || []) fn({ detail });
    },
    count: (type) => listeners.get(type)?.size || 0,
  };
}

/** Controller wired to fakes; returns the controller, the target, and a state log. */
function harness({ now = () => 0 } = {}) {
  const target = makeEventTarget();
  const intervals = [];
  let hidden = false;
  const controller = new SatelliteFeedController({
    now,
    isDocumentHidden: () => hidden,
    setInterval: (fn, ms) => {
      const handle = { fn, ms };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      const i = intervals.indexOf(handle);
      if (i >= 0) intervals.splice(i, 1);
    },
    eventTarget: target,
  });
  const states = [];
  controller.subscribe((s) => states.push(s));
  return { controller, target, states, intervals, setHidden: (v) => { hidden = v; } };
}

test('subscribe replays the current (hidden) state immediately', () => {
  const { states } = harness();
  assert.deepEqual(states, [{ visible: false }]);
});

test('selecting the ISS emits a visible video state with the default source', () => {
  const { target, states } = harness();
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 25544, label: 'ISS' });
  const s = states.at(-1);
  assert.equal(s.visible, true);
  assert.equal(s.kind, 'video');
  assert.equal(s.activeSourceId, 'nasa');
  assert.match(s.mediaUrl, /youtube-nocookie\.com/);
  assert.ok(Array.isArray(s.videoIds) && s.videoIds.length >= 1, 'carries probe candidates');
  assert.deepEqual(s.sources.map((x) => x.id).sort(), ['earth', 'nasa']);
});

test('setVideoSource swaps the embed without another select', () => {
  const { controller, target, states } = harness();
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 25544 });
  controller.setVideoSource('earth');
  assert.equal(states.at(-1).activeSourceId, 'earth');
  assert.notEqual(states.at(-1).mediaUrl, states.at(-2).mediaUrl);
});

test('selecting a GOES sat emits imagery and starts a refresh interval', () => {
  let clock = Date.UTC(2026, 7, 31, 12, 0, 0);
  const { target, states, intervals } = harness({ now: () => clock });
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
  assert.equal(states.at(-1).kind, 'imagery');
  assert.equal(intervals.length, 1);

  const firstUrl = states.at(-1).mediaUrl;
  clock += 20 * 60 * 1000; // advance two buckets
  intervals[0].fn();
  assert.notEqual(states.at(-1).mediaUrl, firstUrl, 'tick re-emits a fresher frame');
});

test('a hidden tab suppresses the imagery refresh emit', () => {
  let clock = Date.UTC(2026, 7, 31, 12, 0, 0);
  const h = harness({ now: () => clock });
  h.target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
  const before = h.states.length;
  h.setHidden(true);
  clock += 20 * 60 * 1000;
  h.intervals[0].fn();
  assert.equal(h.states.length, before, 'no emit while hidden');
  h.setHidden(false);
});

test('selecting a feed-less satellite, or clearing, hides the panel and stops refresh', () => {
  const { target, states, intervals } = harness();
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
  assert.equal(intervals.length, 1);

  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 99999 });
  assert.deepEqual(states.at(-1), { visible: false });
  assert.equal(intervals.length, 0, 'refresh cleared');

  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 25544 });
  target.emit('gev:awareness-subject-cleared', {});
  assert.deepEqual(states.at(-1), { visible: false });
});

test('LIVE FEEDS ONLY suppresses an imagery feed and stops its refresh', () => {
  const { controller, target, states, intervals } = harness();
  controller.setLiveOnly(true);
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
  const s = states.at(-1);
  assert.equal(s.visible, true);
  assert.equal(s.kind, 'imagery');
  assert.equal(s.suppressed, true);
  assert.equal(s.mediaUrl, null);
  assert.equal(intervals.length, 0, 'no refresh interval while suppressed');
});

test('toggling LIVE FEEDS ONLY off re-shows the imagery feed in place', () => {
  const { controller, target, states, intervals } = harness();
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
  assert.equal(intervals.length, 1);

  controller.setLiveOnly(true);
  assert.equal(states.at(-1).suppressed, true);
  assert.equal(intervals.length, 0);

  controller.setLiveOnly(false);
  assert.equal(states.at(-1).kind, 'imagery');
  assert.notEqual(states.at(-1).suppressed, true);
  assert.ok(states.at(-1).mediaUrl);
  assert.equal(intervals.length, 1, 'refresh interval restored');
});

test('LIVE FEEDS ONLY does not touch the ISS video feed', () => {
  const { controller, target, states } = harness();
  controller.setLiveOnly(true);
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 25544 });
  const s = states.at(-1);
  assert.equal(s.kind, 'video');
  assert.notEqual(s.suppressed, true);
  assert.equal(s.activeSourceId, 'nasa');
  assert.equal(controller.isLiveOnly(), true);
});

test('a non-satellite subject is ignored as "no feed"', () => {
  const { target, states } = harness();
  target.emit('gev:awareness-subject-selected', { layerId: 'flights', id: 25544 });
  assert.deepEqual(states.at(-1), { visible: false });
});

test('destroy() removes both listeners and clears the interval', () => {
  const { controller, target, intervals } = harness();
  target.emit('gev:awareness-subject-selected', { layerId: 'satellites', id: 60133 });
  assert.equal(intervals.length, 1);
  controller.destroy();
  assert.equal(intervals.length, 0);
  assert.equal(target.count('gev:awareness-subject-selected'), 0);
  assert.equal(target.count('gev:awareness-subject-cleared'), 0);
});

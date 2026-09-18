import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandomRoamController } from './randomRoam.js';

function button() {
  const el = new EventTarget();
  el.classList = {
    values: new Set(),
    toggle(name, enabled) {
      if (enabled) this.values.add(name);
      else this.values.delete(name);
    },
    contains(name) {
      return this.values.has(name);
    },
  };
  el.attributes = new Map();
  el.setAttribute = (key, value) => el.attributes.set(key, String(value));
  el.getAttribute = (key) => el.attributes.get(key) || null;
  return el;
}

function makeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(callback, delay) {
      const token = { callback, delay, cleared: false };
      scheduled.push(token);
      return token;
    },
    clearTimeout(token) {
      if (token) token.cleared = true;
    },
  };
}

function makeViewer() {
  const flights = [];
  let cancelled = 0;
  return {
    flights,
    get cancelled() {
      return cancelled;
    },
    camera: {
      flyTo(options) {
        flights.push(options);
      },
      cancelFlight() {
        cancelled += 1;
      },
    },
  };
}

test('random roam starts a bounded random camera flight and marks its toggle active', () => {
  const viewer = makeViewer();
  const toggle = button();
  const timers = makeTimers();
  const randomValues = [0, 0.5, 1, 0.25, 0.75, 0.1];
  const controller = createRandomRoamController({
    viewer,
    button: toggle,
    random: () => randomValues.shift() ?? 0.5,
    timers,
    cartesianFromDegrees: (lon, lat, height) => ({ lon, lat, height }),
    toRadians: (deg) => deg,
  });

  assert.equal(controller.start(), true);

  assert.equal(controller.active, true);
  assert.equal(toggle.classList.contains('active'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(viewer.flights.length, 1);
  assert.deepEqual(viewer.flights[0].destination, {
    lon: -180,
    lat: 0,
    height: 2500000,
  });
  assert.deepEqual(viewer.flights[0].orientation, {
    heading: Math.PI * 0.5,
    pitch: -46.25,
    roll: 0,
  });
  assert.equal(viewer.flights[0].duration, 9);
  assert.equal(timers.scheduled.length, 0);
});

test('random roam schedules another hop only after a completed flight', () => {
  const viewer = makeViewer();
  const timers = makeTimers();
  const controller = createRandomRoamController({
    viewer,
    button: button(),
    random: () => 0.5,
    timers,
    cartesianFromDegrees: (lon, lat, height) => ({ lon, lat, height }),
    toRadians: (deg) => deg,
  });

  controller.start();
  viewer.flights[0].complete();

  assert.equal(timers.scheduled.length, 1);
  assert.ok(timers.scheduled[0].delay >= 3000);
  assert.ok(timers.scheduled[0].delay <= 9000);
  timers.scheduled[0].callback();
  assert.equal(viewer.flights.length, 2);
});

test('random roam stop cancels the active flight and prevents queued hops', () => {
  const viewer = makeViewer();
  const toggle = button();
  const timers = makeTimers();
  const controller = createRandomRoamController({
    viewer,
    button: toggle,
    random: () => 0.5,
    timers,
    cartesianFromDegrees: (lon, lat, height) => ({ lon, lat, height }),
    toRadians: (deg) => deg,
  });

  controller.start();
  viewer.flights[0].complete();
  controller.stop();
  timers.scheduled[0].callback();

  assert.equal(controller.active, false);
  assert.equal(toggle.classList.contains('active'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(viewer.cancelled, 1);
  assert.equal(timers.scheduled[0].cleared, true);
  assert.equal(viewer.flights.length, 1);
});

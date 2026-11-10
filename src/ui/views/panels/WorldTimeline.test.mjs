// The world timeline shows the world time while a layer with time to show is
// on, with play and pause on the left and the way back to live on the right.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { worldClock } from '../../../time/worldClock.js';
import WorldTimeline from './WorldTimeline.vue';
import { useWorldTimeStore } from '../../stores/worldTime.js';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(WorldTimeline).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => {
    app.unmount();
    // The store outlives the view; dispose it with its clock subscription.
    useWorldTimeStore(pinia).$dispose();
    worldClock.goLive();
  });
  return () => document.getElementById('world-timeline');
}

// A layer that moves with the clock and has an hour of frames.
function supportingLayer(t, at) {
  const release = worldClock.hold('test-radar');
  const unregister = worldClock.register({
    id: 'test-radar',
    coverage: () => ({ start: at - 3_600_000, end: at }),
  });
  t.after(() => {
    unregister();
    release();
  });
  return () => {
    unregister();
    release();
  };
}

test('the timeline shows live, and plays, pauses and goes back', async (t) => {
  const bar = mount(t);
  const at = Date.UTC(2026, 9, 30, 6, 15, 42);
  supportingLayer(t, at);
  await nextTick();
  assert.ok(bar(), 'shown while live');
  const live = bar().querySelector('.world-timeline-live');
  assert.equal(live.disabled, true, 'already live');
  assert.equal(live.getAttribute('aria-pressed'), 'true');

  worldClock.seek(at);
  await nextTick();
  assert.ok(bar());
  const time = bar().querySelector('time');
  assert.equal(time.getAttribute('datetime'), new Date(at).toISOString());
  assert.match(time.textContent, /UTC$/);
  const play = bar().querySelector('.world-timeline-play');
  assert.equal(play.getAttribute('aria-label'), 'Play');

  play.click();
  await nextTick();
  assert.equal(worldClock.isPlaying(), true);
  assert.equal(play.getAttribute('aria-label'), 'Pause');
  play.click();
  await nextTick();
  assert.equal(worldClock.isPlaying(), false);

  assert.equal(bar().querySelector('.world-timeline-live').disabled, false);
  bar().querySelector('.world-timeline-live').click();
  await nextTick();
  assert.equal(worldClock.isLive(), true);
  assert.ok(bar(), 'still shown, live');
  assert.equal(bar().querySelector('.world-timeline-live').disabled, true);
});

test('the timeline hides while no layer with time to show is on', async (t) => {
  const bar = mount(t);
  const at = Date.UTC(2026, 9, 30, 6, 15, 42);
  await nextTick();
  assert.equal(bar(), null, 'live, nothing to play');
  worldClock.seek(at);
  await nextTick();
  assert.equal(bar(), null, 'away from live, but nothing to play');
  const remove = supportingLayer(t, at);
  await nextTick();
  assert.ok(bar());
  remove();
  await nextTick();
  assert.equal(bar(), null, 'the layer went off');
});

test('the track runs over the time the layers show, to now, and scrubs', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const at = now - 2 * 86_400_000;
  const release = worldClock.hold('test-launches');
  const unregister = worldClock.register({
    id: 'test-launches',
    coverage: () => ({ start: at - 86_400_000, end: at, marks: [at - 86_400_000, at] }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  const input = bar().querySelector('input[type=range]');
  assert.equal(Number(input.min), at - 86_400_000);
  assert.ok(Number(input.max) >= now, 'reaches to now');
  assert.equal(bar().querySelectorAll('.world-timeline-tick').length, 2);

  worldClock.play();
  input.value = String(at);
  input.dispatchEvent(new Event('input'));
  await nextTick();
  assert.equal(worldClock.isPlaying(), false, 'a scrub stops playback');
  assert.equal(worldClock.now(), at);
  assert.equal(bar().querySelector('time').getAttribute('datetime'), new Date(at).toISOString());

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  await nextTick();
  assert.equal(worldClock.now(), at - 86_400_000, 'the arrow goes to the previous mark');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  await nextTick();
  assert.equal(worldClock.now(), at, 'and back to the next');

  input.value = String(Date.now() + 2_000);
  input.dispatchEvent(new Event('input'));
  await nextTick();
  assert.equal(worldClock.isLive(), true, 'a scrub to now goes live');

  // A layer that reaches ahead of now, as satellites do.
  const holdAhead = worldClock.hold('test-ahead');
  const unregisterAhead = worldClock.register({
    id: 'test-ahead',
    coverage: () => ({ start: now, end: now + 3 * 86_400_000 }),
  });
  t.after(() => {
    unregisterAhead();
    holdAhead();
  });
  await nextTick();
  const ahead = Date.now() + 86_400_000;
  input.value = String(ahead);
  input.dispatchEvent(new Event('input'));
  await nextTick();
  assert.equal(worldClock.isLive(), false, 'a scrub past now stays there');
  assert.equal(worldClock.now(), ahead);
});

test('play runs in real time, from the start of the track when at live', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const start = now - 10 * 86_400_000;
  const release = worldClock.hold('test-launches');
  const unregister = worldClock.register({
    id: 'test-launches',
    coverage: () => ({ start, end: now - 86_400_000 }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  // Weather's replay stepping its own frames does not take the track's play.
  const stepped = [];
  const driver = worldClock.attachDriver({
    play: () => stepped.push('play'),
    pause: () => stepped.push('pause'),
  });
  t.after(() => driver.detach());
  bar().querySelector('.world-timeline-play').click();
  worldClock.pause();
  await nextTick();
  assert.deepEqual(stepped, []);
  const rate = worldClock.getRate();
  assert.ok(worldClock.now() - start < rate * 1_000, 'from the start of the track');
  assert.equal(rate, 1, 'real time to start with');
  worldClock.play({ continuous: true });

  // Playing on to now goes live.
  worldClock.seek(Date.now() + 1_000);
  await nextTick();
  assert.equal(worldClock.isLive(), true);
  assert.equal(worldClock.isPlaying(), false);
  assert.equal(worldClock.getRate(), 1, 'live plays at the rate of the world');
});

test('play holds at the end of a track that reaches past now', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  // An hour ahead is within the track's share of now, but still ahead of it.
  const end = now + 3_600_000;
  const release = worldClock.hold('test-ahead');
  const unregister = worldClock.register({
    id: 'test-ahead',
    coverage: () => ({ start: now - 10 * 86_400_000, end }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  // Paused just past now, play plays on rather than from the top.
  worldClock.seek(Date.now() + 1_000);
  await nextTick();
  const from = worldClock.now();
  bar().querySelector('.world-timeline-play').click();
  worldClock.pause();
  assert.ok(worldClock.now() >= from, 'plays on from where it was');
  worldClock.play();
  worldClock.seek(end + 60_000);
  await nextTick();
  assert.equal(worldClock.isPlaying(), false);
  assert.equal(worldClock.isLive(), false);
  assert.equal(worldClock.now(), end);
});

test('the speed chosen sets how fast play runs, at once while playing', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const release = worldClock.hold('test-launches');
  const unregister = worldClock.register({
    id: 'test-launches',
    coverage: () => ({ start: now - 10 * 86_400_000, end: now - 86_400_000 }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  const select = bar().querySelector('select.world-timeline-speed');
  assert.equal(select.value, 'real');
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ['real', 'minute', 'hour', 'day', 'week'],
  );
  select.value = 'week';
  select.dispatchEvent(new Event('change'));
  await nextTick();
  bar().querySelector('.world-timeline-play').click();
  assert.equal(worldClock.getRate(), 604_800, 'a week a second');
  select.value = 'hour';
  select.dispatchEvent(new Event('change'));
  await nextTick();
  assert.equal(worldClock.isPlaying(), true);
  assert.equal(worldClock.getRate(), 3_600, 'changed while playing');
  select.value = 'minute';
  select.dispatchEvent(new Event('change'));
  await nextTick();
  assert.equal(worldClock.getRate(), 60, 'a minute a second');
  select.value = 'real';
  select.dispatchEvent(new Event('change'));
  await nextTick();
  assert.equal(worldClock.getRate(), 1, 'the world as it goes');
});

test('a speed chosen while weather replay steps takes playback over', async (t) => {
  const bar = mount(t);
  const at = Date.now() - 3_600_000;
  supportingLayer(t, at);
  const calls = [];
  const driver = worldClock.attachDriver({
    play() {
      calls.push('play');
      driver.driven(true, at - 600_000);
    },
    pause() {
      calls.push('pause');
      driver.driven(false);
    },
  });
  t.after(() => driver.detach());
  worldClock.play();
  await nextTick();
  assert.equal(worldClock.getState().stepping, true);
  const select = bar().querySelector('select.world-timeline-speed');
  select.value = 'hour';
  select.dispatchEvent(new Event('change'));
  await nextTick();
  assert.deepEqual(calls, ['play', 'pause']);
  assert.equal(worldClock.getState().stepping, false);
  assert.equal(worldClock.isPlaying(), true);
  assert.equal(worldClock.getRate(), 3_600);
  assert.ok(worldClock.now() - (at - 600_000) < 3_600 * 1_000, 'on from where it was');
  worldClock.pause();
});

test('paused just before the end, play carries on rather than restarting', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const end = now + 86_400_000;
  const release = worldClock.hold('test-ahead');
  const unregister = worldClock.register({
    id: 'test-ahead',
    coverage: () => ({ start: now - 86_400_000, end }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  worldClock.seek(end - 4_000);
  await nextTick();
  bar().querySelector('.world-timeline-play').click();
  worldClock.pause();
  assert.ok(worldClock.now() >= end - 4_000, 'not back to the start');
});

test('the track zooms around the handle, follows it, and shows it all again', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const start = now - 26 * 86_400_000;
  const release = worldClock.hold('test-launches');
  const unregister = worldClock.register({
    id: 'test-launches',
    // A month of launches and three hours of lightning, sharing one track.
    coverage: () => ({
      start,
      end: now,
      marks: [start, now - 3 * 3_600_000, now - 2 * 3_600_000, now - 3_600_000],
    }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  const track = bar().querySelector('.world-timeline-track');
  const input = bar().querySelector('input[type=range]');
  const length = () => Number(input.max) - Number(input.min);
  const full = length();
  assert.equal(bar().querySelectorAll('.world-timeline-tick').length, 4);

  // Live, the handle is at the end: zooming in keeps the view on now.
  for (let i = 0; i < 10; i++) {
    track.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, cancelable: true }));
    await nextTick();
  }
  assert.ok(length() < full / 100, 'zoomed in');
  assert.ok(Number(input.max) >= now, 'still ending at now');
  assert.equal(track.classList.contains('is-zoomed'), true);
  assert.equal(bar().querySelectorAll('.world-timeline-tick').length, 3, 'only the ticks in view');

  // A seek off the view takes the view along.
  worldClock.seek(start + 86_400_000);
  await nextTick();
  assert.ok(Number(input.min) <= start + 86_400_000 && Number(input.max) >= start + 86_400_000);
  assert.ok(length() < full / 100, 'at the same zoom');

  // Minus widens, zero and a double-click show it all.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }));
  await nextTick();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
  await nextTick();
  assert.ok(Math.abs(length() - full) < 1_000, 'all of it');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
  await nextTick();
  assert.ok(length() < full);
  track.dispatchEvent(new MouseEvent('dblclick'));
  await nextTick();
  assert.equal(track.classList.contains('is-zoomed'), false);
});

test('zoomed, a scrub near now stays off live, and the view keeps a still handle', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const start = now - 26 * 86_400_000;
  let end = now;
  const release = worldClock.hold('test-launches');
  const unregister = worldClock.register({
    id: 'test-launches',
    coverage: () => ({ start, end, marks: [start, now - 3_600_000] }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  const track = bar().querySelector('.world-timeline-track');
  const input = bar().querySelector('input[type=range]');
  // Ten notches of a line-mode wheel, as Firefox sends them.
  for (let i = 0; i < 10; i++) {
    track.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, deltaMode: 1, cancelable: true }));
    await nextTick();
  }
  assert.ok(Number(input.max) - Number(input.min) < 6 * 3_600_000, 'lines zoom like pixels');

  // Twenty minutes back is near now on a month, not on a few hours.
  input.value = String(now - 20 * 60_000);
  input.dispatchEvent(new Event('input'));
  await nextTick();
  assert.equal(worldClock.isLive(), false);
  assert.ok(Math.abs(worldClock.now() - (now - 20 * 60_000)) < 1_000);

  // The span running on past the paused handle takes the view back to it.
  end = now + 86_400_000;
  worldClock.coverageChanged();
  await nextTick();
  const at = worldClock.now();
  assert.ok(Number(input.min) <= at && Number(input.max) >= at, 'handle in view');

  // With a modifier, plus is the browser's zoom.
  const browserZoom = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true });
  input.dispatchEvent(browserZoom);
  assert.equal(browserZoom.defaultPrevented, false);

  // A double-click puts back the time its first press moved.
  track.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  track.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  input.value = String(at - 3_600_000);
  input.dispatchEvent(new Event('input'));
  track.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await nextTick();
  assert.equal(track.classList.contains('is-zoomed'), false);
  assert.ok(Math.abs(worldClock.now() - at) < 1_000, 'time as it was');
});

test('play held for a layer to load shows a spinner once the hold lasts', async (t) => {
  const bar = mount(t);
  const at = Date.UTC(2026, 9, 30, 6, 15, 42);
  supportingLayer(t, at);
  worldClock.seek(at - 1_800_000);
  worldClock.play({ continuous: true });
  await nextTick();
  const bubble = () => bar().querySelector('.world-timeline-time');
  const release = worldClock.wait('test-radar');
  t.after(release);
  // A clock tick (a quarter second) tells of the hold; the spinner waits on.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await nextTick();
  assert.equal(bubble().querySelector('.world-timeline-spinner'), null, 'not for a quick frame');
  // The clock tells of the hold on its next tick, and the bar shows it after.
  const until = async (shown) => {
    for (let waited = 0; waited < 3_000; waited += 50) {
      if (Boolean(bubble().querySelector('.world-timeline-spinner')) === shown) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await nextTick();
    }
    return false;
  };
  assert.ok(await until(true), 'spinner once the hold lasts');
  assert.match(bubble().textContent, /UTC$/, 'the time stays');
  release();
  assert.ok(await until(false), 'gone once play goes on');
});

test('the track drags along, a tap goes to its time, and the handle waits off it', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const start = now - 26 * 86_400_000;
  const release = worldClock.hold('test-launches');
  const unregister = worldClock.register({
    id: 'test-launches',
    coverage: () => ({ start, end: now, marks: [start] }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  const track = bar().querySelector('.world-timeline-track');
  const input = bar().querySelector('input[type=range]');
  // A 1000 px track from x = 0.
  Object.defineProperty(track, 'clientWidth', { value: 1_000 });
  track.getBoundingClientRect = () => ({ left: 0, width: 1_000, top: 0, height: 24 });
  const press = (type, clientX, pointerId = 1) =>
    track.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId }));
  const view = () => ({ min: Number(input.min), max: Number(input.max) });

  // All of it shown, a tap goes to the time under it.
  press('pointerdown', 500);
  press('pointerup', 500);
  await nextTick();
  const middle = start + (now - start) / 2;
  assert.ok(Math.abs(worldClock.now() - middle) < 60_000, 'went to the middle');

  // Zoomed to a day around it, dragging right by half the track goes back half a day.
  for (let i = 0; i < 6; i++) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
    await nextTick();
  }
  const before = view();
  const day = before.max - before.min;
  press('pointerdown', 600, 2);
  press('pointermove', 700, 2);
  press('pointermove', 1_100, 2);
  press('pointerup', 1_100, 2);
  await nextTick();
  assert.ok(Math.abs(view().max - (before.max - day / 2)) < 1_000, 'dragged half a view');
  assert.ok(Math.abs(worldClock.now() - middle) < 60_000, 'a drag leaves the time');

  // Dragged off the handle, it waits unseen at the edge; a sideways swipe drags too.
  track.dispatchEvent(new WheelEvent('wheel', { deltaX: -2_000, deltaY: 0, cancelable: true }));
  await nextTick();
  assert.ok(view().max < worldClock.now(), 'the handle is past the view');
  assert.equal(input.classList.contains('is-off-view'), true);
  // Moving the time takes the view back to it.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
  await nextTick();
  assert.equal(input.classList.contains('is-off-view'), false);
});

test('a pinch measures from where the fingers are, and a lifted finger ends it', async (t) => {
  const bar = mount(t);
  const now = Date.now();
  const start = now - 26 * 86_400_000;
  const release = worldClock.hold('test-launches');
  const unregister = worldClock.register({
    id: 'test-launches',
    coverage: () => ({ start, end: now, marks: [start] }),
  });
  t.after(() => {
    unregister();
    release();
  });
  await nextTick();
  const track = bar().querySelector('.world-timeline-track');
  const input = bar().querySelector('input[type=range]');
  Object.defineProperty(track, 'clientWidth', { value: 1_000 });
  track.getBoundingClientRect = () => ({ left: 0, width: 1_000, top: 0, height: 24 });
  const on = (target, type, clientX, pointerId) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId }));
  const length = () => Number(input.max) - Number(input.min);
  for (let i = 0; i < 4; i++) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
    await nextTick();
  }
  const before = length();
  // A finger on the handle moves before the second comes down.
  on(input, 'pointerdown', 300, 1);
  on(input, 'pointermove', 500, 1);
  on(track, 'pointerdown', 700, 2);
  on(input, 'pointermove', 500, 1);
  await nextTick();
  assert.ok(Math.abs(length() - before) < 1_000, 'no zoom from a stale finger');
  on(track, 'pointermove', 900, 2);
  await nextTick();
  assert.ok(length() < before, 'spread apart, it zooms in');
  // One finger up: the other moving does nothing, and throws nothing.
  const zoomedTo = length();
  on(track, 'pointerup', 900, 2);
  on(input, 'pointermove', 100, 1);
  await nextTick();
  assert.ok(Math.abs(length() - zoomedTo) < 1_000);
  on(input, 'pointercancel', 100, 1);
});

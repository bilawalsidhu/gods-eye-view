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

// The world timeline shows the world time while it is away from live, with
// play and pause on the left and the way back to live on the right.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { worldClock } from '../../../time/worldClock.js';
import WorldTimeline from './WorldTimeline.vue';

test('the timeline shows away from live and plays, pauses and goes back', async (t) => {
  document.body.replaceChildren();
  const app = createApp(WorldTimeline).use(createPinia());
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => {
    app.unmount();
    worldClock.goLive();
  });
  const bar = () => document.getElementById('world-timeline');
  await nextTick();
  assert.equal(bar(), null, 'hidden while live');

  const at = Date.UTC(2026, 9, 30, 6, 15, 42);
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

  bar().querySelector('.world-timeline-live').click();
  await nextTick();
  assert.equal(worldClock.isLive(), true);
  assert.equal(bar(), null);
});

import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useStoriesStore } from './stores/stories.js';
import { storyById } from '../stories/catalog.js';
import StoryScreen from './views/stories/StoryScreen.vue';
import StoriesView from './views/StoriesView.vue';

test('the announcement stays unread when a lazy Stories open resolves to false', async (t) => {
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const store = useStoriesStore(pinia);
  let allowed = false;
  store.connect({ open: async () => allowed });
  const app = createApp(StoriesView).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
    localStorage.removeItem('gevStoriesPopSeen');
  });

  const entry = host.querySelector('#hStories');
  entry.click();
  await nextTick();
  assert.equal(localStorage.getItem('gevStoriesPopSeen'), null);
  assert.ok(host.querySelector('#hPop'));

  allowed = true;
  entry.click();
  await nextTick();
  assert.equal(localStorage.getItem('gevStoriesPopSeen'), '1');
});

test('the story screen previews a drag and seeks once on release', async (t) => {
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const store = useStoriesStore(pinia);
  const builtIn = storyById('gev:flights-radar');
  const first = builtIn.chapters[0];
  const story = {
    ...builtIn,
    durationMs: 24000,
    chapters: [first, { ...first, id: 'second', wallMs: 12000 }],
  };
  const seeks = [];
  store.connect(
    {
      seek(ms) {
        seeks.push(ms);
        store.playback.wallMs = ms;
      },
    },
    [story],
  );
  const app = createApp(StoryScreen, { story }).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });

  const track = host.querySelector('#tlTrack');
  track.getBoundingClientRect = () => ({ left: 0, width: 400 });
  const pointer = (type, clientX) =>
    track.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX }));
  const progress = () => Number(track.getAttribute('aria-valuenow'));
  const before = progress();
  pointer('pointerdown', 45);
  pointer('pointermove', 60);
  pointer('pointermove', 80);
  await nextTick();
  const preview = progress();
  assert.ok(preview > before);
  assert.deepEqual(seeks, []);
  pointer('pointerup', 80);
  await nextTick();
  assert.equal(seeks.length, 1);
  assert.equal(progress(), preview);
  assert.equal(progress(), Math.round((seeks[0] / story.durationMs) * 100));

  pointer('pointerdown', 300);
  await nextTick();
  assert.notEqual(progress(), preview);
  pointer('pointercancel', 300);
  await nextTick();
  assert.equal(progress(), preview);
  assert.equal(seeks.length, 1);
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
  await nextTick();
  assert.equal(track.querySelector('.tl-seg.now')?.dataset.k, '1');
  track.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }));
  await nextTick();
  assert.equal(track.querySelector('.tl-seg.now')?.dataset.k, '0');
  assert.deepEqual(seeks.slice(1), [23990, first.wallMs + 1]);
});

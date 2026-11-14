// src/data/bhoteKoshiPanelView.test.mjs — the context rail renders the Bhote
// Koshi reconstruction panel the event layer presents and sends its clicks
// and slider moves back.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useBhoteKoshiPanelStore } from '../ui/stores/bhoteKoshiPanel.js';
import ContextView from '../ui/views/ContextView.vue';

const record = (initial = {}) => ({
  textContent: '',
  hidden: false,
  disabled: false,
  value: '',
  attributes: {},
  ...initial,
});

function presentation(patch = {}) {
  return {
    owner: {},
    sceneBeat: false,
    beforeDate: { name: 'Historical reference', date: '2021-05-01' },
    afterDate: { name: 'Post-event', date: '' },
    reports: [
      { label: 'Report A', status: 'Verified' },
      { label: 'Report B', status: 'Unverified' },
    ],
    refs: {
      imagerySection: record(),
      observedStatus: record(),
      time: record({ textContent: '~0:00 / 2:00' }),
      caveat: record({ textContent: 'Schematic only.' }),
      imageryCloudNote: record(),
      playButton: record({ textContent: '▶ PLAY' }),
      playSceneButton: record({ textContent: '▶ PLAY SCENE', hidden: true }),
      cinematicButton: record({
        textContent: '◉ CINEMATIC',
        attributes: { 'aria-pressed': 'false' },
      }),
      storyReplayButton: record({ textContent: '↺ FULL STORY' }),
      corridorButton: record(),
      previousButton: record({
        disabled: true,
        attributes: { 'aria-label': 'Previous story beat' },
      }),
      nextButton: record({ attributes: { 'aria-label': 'Next story beat' } }),
      openSourceButton: record(),
      progressInput: record({
        value: '0',
        attributes: { 'aria-label': 'Schematic downstream progression' },
      }),
      splitInput: record({ value: '50' }),
      splitReadout: record({ textContent: '50 / 50' }),
      timelineLabel: record({ textContent: 'RECONSTRUCTION CLOCK' }),
      beatIndex: record({ textContent: '01 / 06' }),
      beatTitle: record({ textContent: 'CAUSE' }),
      beatMeta: record({ textContent: 'CAPTURE TIME UNVERIFIED' }),
    },
    ...patch,
  };
}

function fixture(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(ContextView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  const store = useBhoteKoshiPanelStore(pinia);
  const calls = [];
  store.connect(
    new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) =>
            calls.push([name, ...args]),
      },
    ),
  );
  const rail = document.getElementById('right-context-rail');
  const $ = (selector) => rail.querySelector(selector);
  return { store, calls, rail, $ };
}

test('the panel renders last in the context rail and marks the rail while on', async (t) => {
  const { store, rail, $ } = fixture(t);
  assert.equal($('#bhote-koshi-event-panel'), null);
  assert.equal(rail.classList.contains('bhote-event-active'), false);
  store.publish(presentation());
  await nextTick();
  const panel = $('#bhote-koshi-event-panel');
  assert.equal(panel.tagName, 'ASIDE');
  assert.ok(rail.lastElementChild === panel);
  assert.ok(rail.classList.contains('ui-scroll'));
  assert.ok(rail.classList.contains('bhote-event-active'));
  assert.equal(
    panel.getAttribute('aria-label'),
    'Bhote Koshi flood reconstruction controls',
  );
  assert.match(
    panel.textContent,
    /2021 HISTORICAL REFERENCE \/ 2026 POST-EVENT/,
  );
  assert.match(panel.textContent, /RECONSTRUCTION CLOCK/);
  assert.match(panel.textContent, /OPEN PUBLIC MAP/);
  assert.equal(
    $('[data-role="before-date"]').textContent,
    'Historical reference · 2021-05-01',
  );
  assert.equal(
    $('[data-role="before-date"] .bhote-event-date').textContent,
    '2021-05-01',
  );
  assert.equal($('[data-role="after-date"]').textContent, 'Post-event');
  assert.equal($('[data-role="after-date"] .bhote-event-date'), null);
  assert.equal($('[data-action="play-scene"]').hidden, true);
  assert.ok($('[data-action="open-source"]'));
  assert.equal($('[data-action="witness"]'), null);
  assert.doesNotMatch(panel.innerHTML, /witness/i);
  assert.equal($('[data-action="previous-beat"]').disabled, true);
  assert.equal($('[data-action="previous-beat"]').title, 'Previous story beat');
  assert.equal(
    $('[data-action="cinematic"]').getAttribute('aria-pressed'),
    'false',
  );
  assert.equal($('[data-action="play"]').hasAttribute('aria-label'), false);
  assert.equal($('[data-role="progress"]').value, '0');
  assert.equal($('[data-role="split"]').value, '50');
  assert.equal($('summary').textContent, 'FIELD REPORTS · 2');
  assert.deepEqual(
    [...$('.bhote-event-report-list').children].map(
      (button) => button.textContent,
    ),
    ['Report AVerified', 'Report BUnverified'],
  );
  store.publish(null);
  await nextTick();
  assert.equal($('#bhote-koshi-event-panel'), null);
  assert.equal(rail.classList.contains('bhote-event-active'), false);
  assert.ok(rail.classList.contains('ui-scroll'));
});

test('a later presentation updates the controls in place', async (t) => {
  const { store, $ } = fixture(t);
  store.publish(presentation());
  await nextTick();
  const play = $('[data-action="play"]');
  const next = presentation({ sceneBeat: true });
  next.refs.playButton = record({
    textContent: '▶ PLAY SHOT',
    disabled: true,
    attributes: { 'aria-label': 'Play Global context' },
  });
  next.refs.progressInput = record({ value: '250', hidden: true });
  next.refs.imagerySection = record({ hidden: true });
  store.publish(next);
  await nextTick();
  assert.ok($('[data-action="play"]') === play);
  assert.equal(play.textContent, '▶ PLAY SHOT');
  assert.equal(play.disabled, true);
  assert.equal(play.getAttribute('aria-label'), 'Play Global context');
  assert.ok(
    $('#bhote-koshi-event-panel').classList.contains('bhote-event-scene-beat'),
  );
  assert.equal($('[data-role="progress"]').value, '250');
  assert.equal($('[data-role="progress"]').hidden, true);
  assert.equal($('[data-role="imagery-comparison"]').hidden, true);
});

test('buttons, sliders and reports call the connected controls', async (t) => {
  const { store, calls, $ } = fixture(t);
  store.publish(presentation());
  await nextTick();
  for (const action of [
    'close',
    'play',
    'cinematic',
    'story-replay',
    'open-source',
    'corridor',
    'next-beat',
    'geolocation-map',
  ])
    $(`[data-action="${action}"]`).click();
  $('.bhote-event-report-list').children[1].click();
  const progress = $('[data-role="progress"]');
  progress.value = '500';
  progress.dispatchEvent(new Event('input'));
  progress.dispatchEvent(new Event('change'));
  const split = $('[data-role="split"]');
  split.value = '25';
  split.dispatchEvent(new Event('input'));
  assert.deepEqual(calls, [
    ['close'],
    ['play'],
    ['toggleCinematic'],
    ['replayCinematic'],
    ['openActiveSource'],
    ['focusCorridor'],
    ['nextBeat'],
    ['openGeolocationMap'],
    ['openReport', 1],
    ['previewProgress', 0.5],
    ['commitProgress', 0.5, { final: true }],
    ['setSplit', 0.25],
  ]);
});

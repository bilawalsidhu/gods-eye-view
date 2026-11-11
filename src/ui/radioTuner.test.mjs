// src/ui/radioTuner.test.mjs — the Radio directory tuner renders what
// RadioControls presents, over happy-dom with the real controls driving it.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { RadioControls } from './radioControls.js';
import { buildRadioTunerTicks } from './radioTunerModel.js';
import { renderRadioState } from './radioPresentation.js';
import { useRadioStore } from './stores/radio.js';
import RadioTuner from './views/panels/RadioTuner.vue';

const STATIONS = [
  { id: 's1', name: 'One' },
  { id: 's2', name: 'Two' },
  { id: 's3', name: 'Three' },
];

function fixture(t, { commitResult = { ok: true }, width = 300 } = {}) {
  document.body.replaceChildren();
  // The dial and slider are laid out `layout.width` wide; happy-dom lays
  // nothing out. Resizes are reported through the stub observer.
  const layout = { width, observers: [] };
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const { width } = layout;
    return this.classList.contains('radio-tuner-dial') ||
      this.id === 'radio-tuner-slider'
      ? { left: 0, top: 0, width, height: 20, right: width, bottom: 20 }
      : rect.call(this);
  };
  const ResizeObserverBefore = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      layout.observers.push(this);
    }
    observe() {}
    disconnect() {
      layout.observers = layout.observers.filter((entry) => entry !== this);
    }
  };
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(RadioTuner).use(pinia);
  app.mount(host);
  const $ = (id) => document.getElementById(id);
  const calls = [];
  let controls = null;
  let render = null;
  const radio = {
    subscribe: () => () => {},
    getTunerStations: () => STATIONS,
    beginTuning: () => (calls.push(['begin']), true),
    previewTuningStation: (id) => calls.push(['preview', id]),
    commitTuningStation: (id) => {
      calls.push(['commit', id]);
      // Radio reports the new selection synchronously, as the real layer does.
      if (commitResult.ok)
        void render({
          selected: STATIONS.find((station) => station.id === id),
        });
      return commitResult;
    },
    cancelTuning: () => calls.push(['cancel']),
    endTuning: () => calls.push(['end']),
  };
  controls = new RadioControls({
    elements: {
      _radioPanel: document.createElement('section'),
      _radioTunerSlider: $('radio-tuner-slider'),
    },
    radio,
    actions: {
      isRegistered: () => true,
      isEnabled: () => true,
      setPanelCollapsed() {},
      setSignalCollapsed() {},
      layoutCockpit() {},
      isCockpitActive: () => false,
      signalUserCollapsed: () => false,
      scheduleLayout() {},
      getLifecycle: () => null,
      preservePanelStateDuringClear: () => true,
    },
    canvas: document.createElement('canvas'),
    store: useRadioStore(pinia),
  });
  t.after(() => {
    controls.destroy();
    app.unmount();
    HTMLElement.prototype.getBoundingClientRect = rect;
    globalThis.ResizeObserver = ResizeObserverBefore;
  });
  render = async (state) => {
    renderRadioState.call(controls, {
      enabled: true,
      categories: [
        { id: 'all', label: 'All', count: 3, color: '' },
        { id: 'news', label: 'News', count: 3, color: '' },
      ],
      filter: 'all',
      filteredCount: 3,
      stationCount: 3,
      volume: 0.8,
      audioState: 'stopped',
      selected: STATIONS[1],
      ...state,
    });
    await nextTick();
  };
  const key = async (type, keyName) => {
    $('radio-tuner-slider').dispatchEvent(
      new KeyboardEvent(type, { key: keyName, bubbles: true }),
    );
    await nextTick();
  };
  const resize = async (width) => {
    layout.width = width;
    for (const observer of layout.observers) observer.callback([]);
    await nextTick();
  };
  const pointer = async (type, clientX) => {
    $('radio-tuner-slider').dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 4, clientX }),
    );
    await nextTick();
  };
  return { $, calls, controls, render, key, resize, pointer };
}

const ratio = (el) => el.style.getPropertyValue('--radio-tuner-ratio');

test('before RadioControls presents, the tuner is hidden with its initial readouts', (t) => {
  const { $ } = fixture(t);
  assert.equal($('radio-tuner').hidden, true);
  const slider = $('radio-tuner-slider');
  assert.equal(slider.disabled, true);
  assert.equal(slider.max, '0');
  assert.equal(slider.value, '0');
  assert.equal(slider.getAttribute('aria-valuetext'), 'No station available');
  assert.equal($('radio-tuner-band-label').textContent, 'DIRECTORY BAND');
  assert.equal($('radio-tuner-value').textContent, 'DRAG TO TUNE');
  assert.equal($('radio-tuner-station').textContent, 'ALL · DRAG THE NEEDLE');
  assert.equal(document.querySelectorAll('.radio-tuner-tick').length, 0);
  assert.equal(ratio($('radio-tuner')), '');
});

test('a render shows the band at the selected station with its tick tape', async (t) => {
  const { $, render } = fixture(t);
  await render();
  const tuner = $('radio-tuner');
  const slider = $('radio-tuner-slider');
  assert.equal(tuner.hidden, false);
  assert.equal(slider.disabled, false);
  assert.equal(slider.max, '2');
  assert.equal(slider.value, '1');
  assert.equal(slider.getAttribute('aria-valuetext'), 'Two, station 2 of 3');
  assert.equal($('radio-tuner-value').textContent, 'CH 02 / 03');
  assert.equal($('radio-tuner-station').textContent, 'Two');
  assert.equal(ratio(tuner), '0.5');
  const ticks = [...document.querySelectorAll('.radio-tuner-tick')];
  assert.ok(ticks.length > 0);
  const current = ticks.filter((tick) => tick.classList.contains('is-current'));
  assert.equal(current.length, 1);
  assert.equal(current[0].dataset.stationIndex, '1');
  assert.match(current[0].style.left, /px$/);
  assert.match(
    tuner
      .querySelector('.radio-tuner-scale')
      .style.getPropertyValue('--radio-tuner-tick-pitch'),
    /px$/,
  );
  await render({ filter: 'news' });
  assert.equal($('radio-tuner-band-label').textContent, 'NEWS BAND');
  await render({ enabled: false });
  assert.equal(tuner.hidden, true);
  assert.equal(slider.disabled, true);
});

test('a keyboard tune drags, previews and commits the next station', async (t) => {
  const { $, calls, render, key } = fixture(t);
  await render();
  const tuner = $('radio-tuner');
  const slider = $('radio-tuner-slider');
  slider.focus();
  await key('keydown', 'ArrowRight');
  assert.equal(tuner.classList.contains('is-dragging'), true);
  assert.equal(slider.value, '2');
  assert.equal(ratio(tuner), '1');
  assert.equal($('radio-tuner-station').textContent, 'Three');
  assert.deepEqual(calls.at(-1), ['preview', 's3']);
  // The drag class comes off only after the needle has been laid out.
  const needle = $('radio-tuner-needle');
  let atLayout = null;
  Object.defineProperty(needle, 'offsetLeft', {
    configurable: true,
    get: () => {
      atLayout = {
        dragging: tuner.classList.contains('is-dragging'),
        ratio: ratio(tuner),
      };
      return 0;
    },
  });
  await key('keyup', 'ArrowRight');
  assert.ok(calls.some(([name, id]) => name === 'commit' && id === 's3'));
  assert.equal(tuner.classList.contains('is-dragging'), false);
  assert.deepEqual({ ...atLayout }, { dragging: true, ratio: '1' });
});

test('Escape cancels a drag back to the slot it started from', async (t) => {
  const { $, calls, render, key } = fixture(t);
  await render();
  const slider = $('radio-tuner-slider');
  slider.focus();
  await key('keydown', 'Home');
  assert.equal(slider.value, '0');
  await key('keydown', 'Escape');
  assert.deepEqual(calls.at(-1), ['cancel']);
  assert.equal(slider.value, '1');
  assert.equal(ratio($('radio-tuner')), '0.5');
  assert.equal($('radio-tuner').classList.contains('is-dragging'), false);
});

test('a station that went off air during the drag says so', async (t) => {
  const { $, render, key } = fixture(t, {
    commitResult: { ok: false, reason: 'station-unavailable' },
  });
  await render();
  $('radio-tuner-slider').focus();
  await key('keydown', 'ArrowLeft');
  await key('keyup', 'ArrowLeft');
  assert.equal($('radio-tuner-value').textContent, 'OFF AIR');
  assert.equal($('radio-tuner-station').textContent, 'STATION UNAVAILABLE');
  assert.equal(
    $('radio-tuner-slider').getAttribute('aria-valuetext'),
    'Station unavailable after directory refresh',
  );
});

test('a native slider input starts from the selected slot, then follows the slider', async (t) => {
  const { $, calls, render } = fixture(t);
  await render();
  const slider = $('radio-tuner-slider');
  const input = async (value) => {
    slider.value = value;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
  };
  await input('0');
  assert.ok(calls.some(([name]) => name === 'begin'));
  assert.deepEqual(calls.at(-1), ['preview', 's2']);
  assert.equal(slider.value, '1');
  await input('2');
  assert.deepEqual(calls.at(-1), ['preview', 's3']);
  assert.equal(slider.value, '2');
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.ok(calls.some(([name, id]) => name === 'commit' && id === 's3'));
});

const ticksShown = () =>
  [...document.querySelectorAll('.radio-tuner-tick')].map((tick) => ({
    left: tick.style.left,
    label: tick.textContent,
    stationIndex: Number(tick.dataset.stationIndex),
    current: tick.classList.contains('is-current'),
  }));
const ticksModelled = (coordinate, count, width) =>
  buildRadioTunerTicks(coordinate, count, width).ticks.map((tick) => ({
    left: `${tick.xPx}px`,
    label: tick.label,
    stationIndex: tick.stationIndex,
    current: tick.current,
  }));

test('the tick tape is the model at the dial width, and follows a resize', async (t) => {
  const { render, resize } = fixture(t);
  await render();
  assert.deepEqual(ticksShown(), ticksModelled(1, 3, 300));
  await resize(180);
  assert.deepEqual(ticksShown(), ticksModelled(1, 3, 180));
});

test('a pointer released between stations snaps the needle before it may animate', async (t) => {
  const { $, calls, render, pointer } = fixture(t);
  await render();
  const tuner = $('radio-tuner');
  await pointer('pointerdown', 190);
  await pointer('pointermove', 230);
  assert.equal(tuner.classList.contains('is-dragging'), true);
  const dragRatio = Number(ratio(tuner));
  assert.ok(dragRatio > 0.5 && dragRatio < 1, `fractional, got ${dragRatio}`);
  let atLayout = null;
  Object.defineProperty($('radio-tuner-needle'), 'offsetLeft', {
    configurable: true,
    get: () => {
      atLayout = {
        dragging: tuner.classList.contains('is-dragging'),
        ratio: ratio(tuner),
      };
      return 0;
    },
  });
  await pointer('pointerup', 230);
  assert.deepEqual(
    calls.filter(([name]) => name === 'commit'),
    [['commit', 's3']],
  );
  assert.deepEqual({ ...atLayout }, { dragging: true, ratio: '1' });
  assert.equal(tuner.classList.contains('is-dragging'), false);
  assert.equal($('radio-tuner-slider').value, '2');
});

test('a cancelled pointer drag returns the needle to where it started', async (t) => {
  const { $, calls, render, pointer } = fixture(t);
  await render();
  await pointer('pointerdown', 20);
  assert.equal($('radio-tuner-slider').value, '0');
  await pointer('pointercancel', 20);
  assert.deepEqual(calls.at(-1), ['cancel']);
  assert.equal($('radio-tuner-slider').value, '1');
  assert.equal(ratio($('radio-tuner')), '0.5');
  assert.equal($('radio-tuner').classList.contains('is-dragging'), false);
});

test('leaving the slider commits a keyboard tune; destroying the controls ends a drag', async (t) => {
  const { $, calls, controls, render, key } = fixture(t);
  await render();
  const slider = $('radio-tuner-slider');
  slider.focus();
  await key('keydown', 'ArrowRight');
  slider.dispatchEvent(new Event('blur'));
  await nextTick();
  assert.ok(calls.some(([name, id]) => name === 'commit' && id === 's3'));
  assert.equal($('radio-tuner').classList.contains('is-dragging'), false);
  slider.focus();
  await key('keydown', 'ArrowLeft');
  assert.equal($('radio-tuner').classList.contains('is-dragging'), true);
  controls.destroy();
  await nextTick();
  assert.equal($('radio-tuner').classList.contains('is-dragging'), false);
  assert.deepEqual(calls.at(-1), ['end']);
});

test('a dial first measured hidden draws its ticks in place once it has a width', async (t) => {
  const { render, resize } = fixture(t, { width: 0 });
  await render();
  // Ticks laid out for no width would slide into place when it appears.
  assert.deepEqual(ticksShown(), []);
  await resize(300);
  assert.deepEqual(ticksShown(), ticksModelled(1, 3, 300));
  // Hiding it again keeps the tape it had.
  await resize(0);
  assert.deepEqual(ticksShown(), ticksModelled(1, 3, 300));
});

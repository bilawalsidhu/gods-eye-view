// src/ui/sdrCardActions.test.mjs — the local RTL-SDR card's controls call
// LocalSdrControls through the radio store, and its gain options read in the
// page language with numeric values.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { localSdrGainOptionLabel } from './localSdrPresentation.js';
import { useRadioStore } from './stores/radio.js';
import SdrCard from './views/panels/SdrCard.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useRadioStore(pinia);
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
  const app = createApp(SdrCard).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return calls;
}
const $ = (id) => document.getElementById(id);
const fire = (el, type, init) =>
  el.dispatchEvent(
    type === 'keydown'
      ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
      : new Event(type, { bubbles: true }),
  );

test('the card’s buttons, gain, tuning and volume call LocalSdrControls', (t) => {
  const calls = mount(t);
  for (const id of [
    'sdr-connect-btn',
    'sdr-locate-btn',
    'sdr-change-device-btn',
    'sdr-mode-fm-btn',
    'sdr-mode-adsb-btn',
  ])
    $(id).click();
  $('sdr-gain-select').value = '20.7';
  fire($('sdr-gain-select'), 'change');
  $('sdr-frequency-input').value = '101.1';
  $('sdr-tune-btn').click();
  $('sdr-frequency-input').value = '95.3';
  const enter = fire($('sdr-frequency-input'), 'keydown', { key: 'Enter' });
  fire($('sdr-frequency-input'), 'keydown', { key: 'a' });
  $('sdr-volume').value = '40';
  fire($('sdr-volume'), 'input');
  assert.equal(enter, false, 'Enter is taken by the tune');
  assert.deepEqual(calls, [
    ['toggleSdrConnection'],
    ['locateSdr'],
    ['changeSdrDevice'],
    ['setSdrMode', 'fm'],
    ['setSdrMode', 'adsb'],
    ['setSdrGain', '20.7'],
    ['tuneSdr', '101.1'],
    ['tuneSdr', '95.3'],
    ['setSdrVolume', 40],
  ]);
});

test('the seek buttons step down and up', (t) => {
  const calls = mount(t);
  for (const id of ['sdr-seek-back-btn', 'sdr-seek-forward-btn']) {
    $(id).disabled = false;
    $(id).click();
  }
  assert.deepEqual(calls, [
    ['seekSdr', -1],
    ['seekSdr', 1],
  ]);
});

test('gain options keep numeric values and read as decibels', (t) => {
  mount(t);
  const options = [...$('sdr-gain-select').options];
  assert.equal(options.length, 30);
  assert.equal(options[0].value, 'auto');
  assert.equal(options[2].value, '0.9');
  assert.equal(options[2].textContent, localSdrGainOptionLabel('0.9'));
  assert.match(options[2].textContent, /^0\.9\sdB$/u);
  assert.equal(options[2].getAttribute('translate'), 'no');
  assert.equal(options.at(-1).value, '49.6');
});

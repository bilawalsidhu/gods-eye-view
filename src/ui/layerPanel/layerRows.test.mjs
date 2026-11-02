// src/ui/layerPanel/layerRows.test.mjs — a layer row's own classes change
// without wiping classes other code adds, such as the voice highlight.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { h, render } from 'vue';
import LayerRows from './LayerRows.vue';

const row = (countLine) => ({
  key: 'flights',
  id: 'flights',
  englishName: 'Flights',
  icon: 'flight',
  name: 'Flights',
  meta: '',
  toggle: {
    classes: [],
    text: 'OFF',
    ariaLabel: 'Flights',
    title: '',
    ariaBusy: 'false',
    ariaDisabled: 'false',
    feedState: '',
  },
  count: { countLine, text: '12', empty: false },
  controls: null,
});

test('the count-line class toggles without dropping the voice highlight', () => {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  render(h(LayerRows, { items: [row(false)] }), container);
  const element = container.querySelector('[data-layer-id="flights"]');
  assert.equal(element.className, 'data-toggle-row');
  element.classList.add('gev-voice-focus');

  render(h(LayerRows, { items: [row(true)] }), container);
  assert.equal(element.classList.contains('data-toggle-row--count-line'), true);
  assert.equal(element.classList.contains('gev-voice-focus'), true);

  render(h(LayerRows, { items: [row(false)] }), container);
  assert.equal(element.classList.contains('data-toggle-row--count-line'), false);
  assert.equal(element.classList.contains('gev-voice-focus'), true);
  assert.equal(element.classList.contains('data-toggle-row'), true);
  render(null, container);
});

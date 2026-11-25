// The voice card names layers, sources and distances in the interface
// language; what the model receives stays English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import {
  attachVoiceResult,
  planStepLabel,
  shownEntityLabel,
} from './speech.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

for (const locale of ['ru', 'es']) {
  test(`voice card is in ${locale} for a layer switch`, (t) => {
    t.after(() => setLocale('en'));
    setLocale(locale);
    const out = attachVoiceResult(
      'set_layer_visibility',
      {
        ok: true,
        layerId: 'flights',
        label: 'Live Flights',
        enabled: true,
        source: 'Flights',
      },
      { layerId: 'flights', enabled: true },
    );
    const view = voiceCardView({ steps: [], result: out });
    assert.doesNotMatch(out.display.title, /Live Flights/);
    assert.doesNotMatch(JSON.stringify(view), /Flights/);
  });
  test(`voice card distance is in ${locale}`, (t) => {
    t.after(() => setLocale('en'));
    setLocale(locale);
    const out = attachVoiceResult('fly_to_location', {
      ok: true,
      label: 'Paris',
      rangeM: 2500,
    });
    assert.doesNotMatch(out.display.lines[0], /2\.5 km/);
  });
  test(`plan label is in ${locale}`, (t) => {
    t.after(() => setLocale('en'));
    setLocale(locale);
    const a = planStepLabel('select_nearest_aircraft', {});
    const b = planStepLabel('set_layer_visibility', {
      layerId: 'earthquakes',
      enabled: true,
    });
    assert.doesNotMatch(a, /Here/);
    assert.doesNotMatch(b, /Earthquakes/);
  });
}

test('en: layer switch, distance and plan labels in English', () => {
  const out = attachVoiceResult(
    'set_layer_visibility',
    {
      ok: true,
      layerId: 'flights',
      label: 'Live Flights',
      enabled: true,
      source: 'Flights',
    },
    { layerId: 'flights', enabled: true },
  );
  assert.equal(out.say, 'Live Flights on.');
  assert.equal(out.display.title, 'Live Flights on');
  assert.deepEqual(out.display.sources, [{ label: 'Flights' }]);
  const fly = attachVoiceResult('fly_to_location', {
    ok: true,
    label: 'Paris',
    rangeM: 2500,
  });
  assert.equal(fly.display.lines[0].replace(/\s/g, ' '), 'Camera range 2.5 km');
  assert.equal(
    planStepLabel('select_nearest_aircraft', {}),
    'Nearest aircraft to Here',
  );
  assert.equal(
    planStepLabel('frame_overhead', { target: 'vessels' }),
    'Frame vessels',
  );
  // The plan names the layer as its result card does, not by its id.
  assert.equal(
    planStepLabel('set_layer_visibility', {
      layerId: 'earthquakes',
      enabled: true,
    }),
    'Earthquakes (24h) on',
  );
});

// FIRMS and ALPR register English entity labels: the model reads them as data
// (get_entity_context, pointer_context), the card shows them translated.
const ENTITY_LABELS = {
  ru: { fire: 'Пожар · FRP 12 МВт', alpr: 'Камера ALPR' },
  es: { fire: 'Incendio · FRP 12 MW', alpr: 'Cámara ALPR' },
};

for (const [locale, shown] of Object.entries(ENTITY_LABELS)) {
  test(`entity labels stay English in the result and show in ${locale}`, (t) => {
    t.after(() => setLocale('en'));
    setLocale(locale);
    const out = attachVoiceResult('get_entity_context', {
      ok: true,
      selected: {
        id: 'fire-1',
        name: 'Fire · FRP 12 MW',
        layerId: 'local-firms',
        layerName: 'NASA FIRMS',
      },
    });
    assert.equal(out.selected.name, 'Fire · FRP 12 MW');
    assert.equal(out.display.title, shown.fire);

    const state = reduceVoiceCard(initialVoiceCardState(), {
      type: 'pointer',
      pointer: { kind: 'this', label: 'ALPR camera' },
    });
    assert.equal(state.pointer.label, 'ALPR camera');
    assert.equal(voiceCardView(state).pointer.text, shown.alpr);
    assert.equal(state.announce, `This: ${shown.alpr}`);
  });
}

test('only the registered entity labels are translated', () => {
  assert.equal(shownEntityLabel('Fire · FRP 4.9 MW'), 'Fire · FRP 4.9 MW');
  assert.equal(shownEntityLabel('ALPR camera'), 'ALPR camera');
  setLocale('ru');
  try {
    assert.equal(shownEntityLabel('Fire · FRP 4.9 MW'), 'Пожар · FRP 4.9 МВт');
    assert.equal(shownEntityLabel('UPS793'), 'UPS793');
    assert.equal(shownEntityLabel('Fire Station 5'), 'Fire Station 5');
  } finally {
    setLocale('en');
  }
});

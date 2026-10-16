// Voice card in the UI language: every tool's plan step, the bare "Layer"
// step, whole error lines and long headlines, the Contacts snapshot clock.
// What the model receives stays English.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { presentResult, shownSnapshotTime } from './resultDisplay.js';
import { CITY_POIS } from '../cityPois.js';
import { attachVoiceResult, narrationLabel, planStepLabel } from './speech.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

const TOOLS = GEV_ACTION_SCHEMAS.map((schema) => schema.name);

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

test('every tool has a plan label, never its raw name', () => {
  for (const name of TOOLS) {
    const label = planStepLabel(name, {});
    assert.notEqual(label, name.replace(/_/g, ' '), name);
    assert.doesNotMatch(label, /_/, name);
  }
  assert.equal(planStepLabel('analyst_query', {}), 'Analyst query');
  assert.equal(
    planStepLabel('adjust_camera_zoom', { direction: 'in' }),
    'Zoom in',
  );
  assert.equal(
    planStepLabel('adjust_camera_zoom', { direction: 'out' }),
    'Zoom out',
  );
  // A tool the card does not know keeps its name in English.
  assert.equal(planStepLabel('brand_new_tool', {}), 'brand new tool');
});

for (const locale of ['ru', 'es']) {
  test(`${locale} plan labels are all translated`, () => {
    const english = Object.fromEntries(
      TOOLS.map((name) => [name, planStepLabel(name, { direction: 'out' })]),
    );
    inLocale(locale, () => {
      for (const name of TOOLS) {
        // A layer switch without a layer is checked below.
        const label = planStepLabel(name, { direction: 'out' });
        assert.notEqual(label, english[name], `${name}: "${label}"`);
      }
    });
  });
}

test('analyst query and an unknown tool in ru and es', () => {
  inLocale('ru', () => {
    assert.equal(planStepLabel('analyst_query', {}), 'Аналитический запрос');
    assert.equal(planStepLabel('brand_new_tool', {}), 'Действие');
  });
  inLocale('es', () => {
    assert.equal(planStepLabel('analyst_query', {}), 'Consulta analítica');
    assert.equal(planStepLabel('brand_new_tool', {}), 'Acción');
  });
});

test('a layer step with no layer agrees with "Capa"', () => {
  const step = (enabled) => planStepLabel('set_layer_visibility', { enabled });
  assert.equal(step(true), 'Layer on');
  assert.equal(step(false), 'Layer off');
  inLocale('es', () => {
    assert.equal(step(true), 'Capa: activada');
    assert.equal(step(false), 'Capa: desactivada');
    // A named layer keeps the shared "{label} on" wording.
    assert.match(
      planStepLabel('set_layer_visibility', {
        layerId: 'earthquakes',
        enabled: true,
      }),
      /: activado$/,
    );
  });
  inLocale('ru', () => {
    assert.equal(step(true), 'Слой: вкл.');
    assert.equal(step(false), 'Слой: выкл.');
  });
});

function cardAfter(name, result, args = {}) {
  let state = reduceVoiceCard(initialVoiceCardState(), {
    type: 'action-call',
    id: 'c1',
    name,
    arguments: args,
  });
  state = reduceVoiceCard(state, {
    type: 'action-result',
    id: 'c1',
    name,
    result: attachVoiceResult(name, result, args),
  });
  return voiceCardView(state);
}

const NO_PLACE = {
  ok: false,
  action: 'select_nearest_aircraft',
  stage: 'location',
  error:
    'Nearest-aircraft selection needs a preset, place name, or latitude and longitude',
  feed: {},
};

test('an error line shows whole, in every language', () => {
  for (const [locale, expected] of [
    ['en', NO_PLACE.error],
    [
      'ru',
      'Для выбора ближайшего самолёта нужен пресет, название места или широта и долгота',
    ],
    [
      'es',
      'Para seleccionar la aeronave más cercana se necesita un preajuste, un nombre de lugar o la latitud y la longitud',
    ],
  ]) {
    const view = inLocale(locale, () =>
      cardAfter('select_nearest_aircraft', NO_PLACE),
    );
    assert.deepEqual(view.result.lines, [expected], locale);
  }
});

test('a successful line keeps its 80-character cap', () => {
  const long = 'x'.repeat(120);
  const view = voiceCardView({
    ...initialVoiceCardState(),
    result: { display: { title: 'T', lines: [long] } },
  });
  assert.equal(view.result.lines[0].length, 80);
});

test('a translated analyst headline fits the card title whole', () => {
  const title =
    'Al menos 12 aeronaves militares en un radio de 40 km de Los Angeles';
  const card = () =>
    voiceCardView({
      ...initialVoiceCardState(),
      result: { display: { title, lines: [] } },
    }).result.title;
  assert.equal(inLocale('es', card), title);
  // English keeps its 64-character title, equal to the spoken headline.
  assert.equal(card().length, 64);
});

test('the snapshot time reads as a UTC clock, dated when not today', () => {
  const iso = '2026-10-15T14:32:05.000Z';
  const sameDay = Date.parse('2026-10-15T23:00:00Z');
  const nextDay = Date.parse('2026-10-16T00:10:00Z');
  assert.equal(shownSnapshotTime(iso, sameDay), iso, 'English keeps ISO');
  inLocale('ru', () => {
    assert.equal(shownSnapshotTime(iso, sameDay), '14:32:05 UTC');
    assert.equal(shownSnapshotTime(iso, nextDay), '15.10.2026, 14:32:05 UTC');
  });
  inLocale('es', () => {
    assert.equal(shownSnapshotTime(iso, sameDay), '14:32:05 UTC');
    assert.equal(shownSnapshotTime(iso, nextDay), '15/10/2026, 14:32:05 UTC');
    assert.equal(shownSnapshotTime('not a time'), 'not a time');
  });
});

test('the Contacts note shows the clock; the model note stays ISO', () => {
  const evaluatedAt = new Date();
  evaluatedAt.setUTCHours(14, 32, 5, 0);
  const iso = evaluatedAt.toISOString();
  const note = `Contacts panel snapshot at ${iso} — the same retained cohort supplies the card, speech, and follow-up memory.`;
  const result = {
    ok: true,
    count: 12,
    complete: true,
    scopeLabel: 'in view',
    display: { scope: 'in view' },
    coverage: { note },
    items: [],
  };
  const notes = inLocale('es', () =>
    presentResult('analyst_query', result).display.notes.join(' | '),
  );
  assert.match(notes, /\(14:32:05 UTC\)/);
  assert.doesNotMatch(notes, /T14:32/);
  assert.equal(result.coverage.note, note, 'the result is not changed');
});

test('plan steps and errors name a preset place in the UI language', () => {
  const failed = {
    ok: false,
    action: 'select_nearest_aircraft',
    stage: 'nearest',
    error:
      'Live Flights is enabled, but no airborne aircraft is loaded in the Tokyo view yet',
    location: { label: 'Tokyo' },
    feed: { state: 'nominal' },
  };
  assert.equal(
    planStepLabel('fly_to_location', { query: 'Tokyo' }),
    'Fly to Tokyo',
  );
  inLocale('es', () => {
    assert.match(planStepLabel('fly_to_location', { query: 'Tokyo' }), /Tokio/);
    assert.match(
      planStepLabel('select_nearest_aircraft', { locationId: 'tokyo' }),
      /Tokio/,
    );
    const view = cardAfter('select_nearest_aircraft', failed);
    assert.match(view.result.lines[0], /Tokio/);
  });
  inLocale('ru', () => {
    assert.match(planStepLabel('fly_to_location', { query: 'Tokyo' }), /Токио/);
  });
  assert.match(failed.error, /Tokyo view/, 'the result stays English');
});

test('the analyst scope names Los Angeles in the UI language', () => {
  const result = {
    ok: true,
    count: 12,
    complete: false,
    scopeLabel: 'within 40 km of Los Angeles',
    display: { scope: 'within 40 km of Los Angeles' },
    coverage: { layersQueried: [{ layerKey: 'military' }] },
    items: [],
  };
  const title = inLocale(
    'es',
    () => presentResult('analyst_query', result).display.title,
  );
  assert.match(title, /Los Ángeles$/, 'the headline is not cut at 64');
  assert.equal(result.scopeLabel, 'within 40 km of Los Angeles');
});

// A preset city id from the tool schema (sf, nyc, dc) reads as its city name.
test('a preset city id names the city in plan steps and narration', () => {
  const step = (id, action = 'fly_to_location') =>
    planStepLabel(action, { locationId: id });
  assert.equal(step('sf'), 'Fly to San Francisco');
  assert.equal(
    narrationLabel('fly_to_location', { locationId: 'dc' }),
    'Washington DC',
  );
  assert.equal(
    planStepLabel('fly_to_location', { query: 'Ulaanbaatar' }),
    'Fly to Ulaanbaatar',
    'other places are shown as given',
  );
  inLocale('es', () => {
    assert.equal(step('tokyo'), 'Volar a Tokio');
    assert.equal(step('nyc'), 'Volar a Nueva York');
    for (const id of ['sf', 'nyc', 'dc'])
      assert.doesNotMatch(step(id), /\b(Sf|Nyc|Dc)$/, id);
  });
  inLocale('ru', () => {
    assert.match(step('dc', 'select_nearest_aircraft'), /Вашингтон/);
  });
});

test('every locationId the voice tools accept is a preset city', () => {
  const ids = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.locationId?.enum))
      node.locationId.enum.forEach((id) => ids.add(id));
    Object.values(node).forEach(visit);
  };
  visit(GEV_ACTION_SCHEMAS);
  assert.ok(ids.size > 0, 'found the locationId enums');
  for (const id of ids) assert.ok(Object.hasOwn(CITY_POIS, id), id);
});

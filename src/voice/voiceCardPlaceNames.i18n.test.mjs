// The voice card names a preset city in the interface language in the
// fly-to headline and the nearest-aircraft distance line; what the model
// says stays English.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { SPEECH_BUILDERS } from './speech.js';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

const FLY = { ok: true, arrived: true, label: 'Tokyo' };
const NEAREST = {
  ok: true,
  layerId: 'flights',
  location: { label: 'Tokyo' },
  aircraft: { callsign: 'JAL123', distanceKm: 12, altitudeM: 3000 },
  feed: {},
};

test('the fly-to headline shows the city in the interface language', () => {
  assert.equal(SPEECH_BUILDERS.fly_to_location(FLY).display.title, 'Tokyo');
  const ru = inLocale('ru', () => SPEECH_BUILDERS.fly_to_location(FLY));
  assert.equal(ru.display.title, 'Токио');
  assert.match(ru.say, /Tokyo/);
  const es = inLocale('es', () => SPEECH_BUILDERS.fly_to_location(FLY));
  assert.equal(es.display.title, 'Tokio');
});

test('the nearest-aircraft distance line shows the city in the interface language', () => {
  const en = SPEECH_BUILDERS.select_nearest_aircraft(NEAREST);
  assert.match(en.display.lines[0], /from Tokyo$/);
  const ru = inLocale('ru', () =>
    SPEECH_BUILDERS.select_nearest_aircraft(NEAREST),
  );
  assert.match(ru.display.lines[0], /Токио/);
  assert.match(ru.say, /Tokyo/);
  const es = inLocale('es', () =>
    SPEECH_BUILDERS.select_nearest_aircraft(NEAREST),
  );
  assert.match(es.display.lines[0], /Tokio/);
});

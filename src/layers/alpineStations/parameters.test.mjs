import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMETER_ID,
  MIN_STALE_AFTER_MS,
  STALE_AFTER_CYCLES,
  STATION_PARAMETER_IDS,
  STATION_PARAMETER_VIEWS,
  formatParameter,
  msToKmh,
  parameterBand,
  parameterLegend,
  parameterProminence,
  parameterValue,
  parameterView,
  staleAfterMs,
  unsupportedParameterIds,
  windCompass,
} from './parameters.js';

const views = () => Object.values(STATION_PARAMETER_VIEWS);

test('every band table is ordered strongest first and has an open floor', () => {
  // `parameterBand` takes the FIRST match, so a table out of order would band
  // a storm as calm. The floor must be open because a working snow sensor
  // reports small negatives over bare ground.
  for (const view of views()) {
    const mins = view.bands.map((band) => band.min);
    assert.deepEqual(
      mins,
      [...mins].sort((a, b) => b - a),
      `${view.id} bands are not descending`,
    );
    assert.equal(mins.at(-1), -Infinity, `${view.id} has no catch-all floor`);
    assert.equal(
      new Set(view.bands.map((band) => band.id)).size,
      view.bands.length,
    );
    for (const band of view.bands)
      assert.match(band.accent, /^#[0-9a-f]{6}$/, `${view.id}/${band.id}`);
  }
});

test('each view names a neutral band that exists in its own table', () => {
  // Marker size is measured from the neutral band; a name that is not in the
  // table would silently flatten every marker to the minimum size.
  for (const view of views())
    assert.ok(
      view.bands.some((band) => band.id === view.neutral),
      `${view.id} neutral "${view.neutral}" is not one of its bands`,
    );
});

test('an unknown or absent view id degrades to the default', () => {
  // The id arrives from a chip, a share link and a voice action.
  assert.equal(parameterView('temperature').id, 'temperature');
  assert.equal(parameterView('nonsense').id, DEFAULT_PARAMETER_ID);
  assert.equal(parameterView(undefined).id, DEFAULT_PARAMETER_ID);
  assert.equal(parameterView(null).id, DEFAULT_PARAMETER_ID);
  assert.ok(STATION_PARAMETER_IDS.includes(DEFAULT_PARAMETER_ID));
});

test('wind is stored in m/s and read in km/h', () => {
  const wind = parameterView('wind');
  assert.equal(wind.field, 'windSpeedMs');
  assert.equal(wind.unit, 'km/h');
  assert.equal(parameterValue({ windSpeedMs: 10 }, wind), 36);
  assert.equal(msToKmh(10), 36);
  assert.equal(msToKmh(2.243), 8.1);
  assert.equal(msToKmh(null), null);
  assert.equal(msToKmh(Number.NaN), null);
});

test('an absent reading is null and a measured zero is a value', () => {
  // The distinction this layer exists to preserve: 0 cm, 0 mm and 0 degrees
  // are all real, common readings.
  const snow = parameterView('snow');
  assert.equal(parameterValue({ snowDepthCm: 0 }, snow), 0);
  assert.equal(parameterValue({ snowDepthCm: null }, snow), null);
  assert.equal(parameterValue({}, snow), null);
  assert.equal(parameterBand(0, snow).id, 'bare');
  assert.equal(parameterBand(null, snow), null);
  assert.equal(parameterBand(-1, snow).id, 'bare', 'bare ground is not absent');
});

test('bands classify at their own boundary and above', () => {
  const wind = parameterView('wind');
  assert.equal(parameterBand(75, wind).id, 'storm');
  assert.equal(parameterBand(74.9, wind).id, 'strong');
  assert.equal(parameterBand(5, wind).id, 'light');
  assert.equal(parameterBand(4.9, wind).id, 'calm');
  assert.equal(parameterBand(0, wind).id, 'calm');
});

test('prominence grows one way from a floor neutral and both ways from a mid one', () => {
  const wind = parameterView('wind');
  assert.equal(parameterProminence(0, wind), 0, 'calm is unremarkable');
  assert.equal(parameterProminence(100, wind), 1, 'a storm is the extreme');
  const temperature = parameterView('temperature');
  assert.equal(parameterProminence(15, temperature), 0, 'a mild day is quiet');
  assert.ok(
    parameterProminence(-30, temperature) > 0.5,
    'severe frost is remarkable',
  );
  assert.ok(parameterProminence(35, temperature) > 0.5, 'heat is remarkable');
  assert.equal(parameterProminence(null, temperature), 0);
  for (const view of views())
    for (const value of [-1e6, -1, 0, 1, 1e6]) {
      const prominence = parameterProminence(value, view);
      assert.ok(
        prominence >= 0 && prominence <= 1,
        `${view.id}(${value}) = ${prominence}`,
      );
    }
});

test('a formatted reading always carries its unit, and absent formats to null', () => {
  assert.equal(formatParameter(12.34, parameterView('wind')), '12 km/h');
  assert.equal(formatParameter(-4.52, parameterView('temperature')), '-4.5 °C');
  assert.equal(formatParameter(37.13, parameterView('snow')), '37 cm');
  assert.equal(
    formatParameter(0.4, parameterView('precipitation')),
    '0.4 mm/10min',
  );
  assert.equal(formatParameter(1014.6, parameterView('pressure')), '1015 hPa');
  for (const view of views()) {
    assert.equal(formatParameter(null, view), null);
    assert.ok(formatParameter(1, view).endsWith(view.unit), view.id);
  }
});

test('the compass is eight-point and wraps, and rejects a broken vane', () => {
  assert.equal(windCompass(0), 'N');
  assert.equal(windCompass(360), 'N');
  assert.equal(windCompass(359), 'N');
  assert.equal(windCompass(45), 'NE');
  assert.equal(windCompass(185), 'S');
  assert.equal(windCompass(-90), 'W');
  assert.equal(windCompass(null), null);
  assert.equal(windCompass(Number.NaN), null);
});

test('staleness scales with a network cadence and never drops below the floor', () => {
  // One SwissMetNet station was last seen seven days back while reporting
  // normally, so a cutoff is required; a slower network needs a longer one.
  assert.equal(staleAfterMs({ cadenceMinutes: 10 }), MIN_STALE_AFTER_MS);
  assert.equal(
    staleAfterMs({ cadenceMinutes: 30 }),
    30 * STALE_AFTER_CYCLES * 60_000,
  );
  assert.ok(staleAfterMs({ cadenceMinutes: 30 }) > staleAfterMs({ cadenceMinutes: 10 }));
  assert.equal(staleAfterMs(null), MIN_STALE_AFTER_MS, 'an unknown network takes the floor');
  assert.equal(staleAfterMs({ cadenceMinutes: 'ten' }), MIN_STALE_AFTER_MS);
});

test('the legend reads quietest first and covers every band', () => {
  for (const view of views()) {
    const legend = parameterLegend(view);
    assert.equal(legend.length, view.bands.length, view.id);
    assert.equal(legend[0].label, view.bands.at(-1).label, view.id);
    assert.equal(legend.at(-1).label, view.bands[0].label, view.id);
    for (const entry of legend) assert.match(entry.color, /^#[0-9a-f]{6}$/);
  }
});

test('no shipped view is left without a network to feed it', () => {
  assert.deepEqual(unsupportedParameterIds(), []);
  // With a hypothetical registry that publishes nothing, every view is listed.
  assert.deepEqual(
    unsupportedParameterIds([{ parameters: [] }]),
    [...STATION_PARAMETER_IDS],
  );
});

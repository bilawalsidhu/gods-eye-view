import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIR_QUALITY_BANDS,
  AIR_QUALITY_UNKNOWN_COLOR,
  airQualityColor,
  normalizeAqhiObservations,
  normalizeAqhiStations,
  readingsInView,
} from './model.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');
const OBSERVED = '2026-01-02T11:00:00Z';

const stationFeature = (id, lon) => ({
  geometry: { coordinates: [lon, 50] },
  properties: { location_id: id, location_name_en: `Station ${id}` },
});
const observation = (id, aqhi) => ({
  properties: { location_id: id, aqhi, observation_datetime: OBSERVED },
});

const IDS = ['zero', 'missing', 'blank', 'b3', 'b4', 'b6', 'b7', 'b10', 'b11'];
const stations = normalizeAqhiStations({
  features: IDS.map((id, index) => stationFeature(id, -100 + index)),
});

test('edge:air-quality: a zero reading and a missing one give different cards', () => {
  const readings = normalizeAqhiObservations(
    {
      features: [
        observation('zero', 0),
        observation('missing', null),
        observation('blank', ''),
      ],
    },
    stations,
    NOW,
  );
  // Zero is a real low reading, published on ECCC's floor of 1.
  assert.deepEqual(
    readings.map(({ id, value, band, label }) => ({ id, value, band, label })),
    [{ id: 'eccc:zero', value: 1, band: 'low', label: '1' }],
  );
  assert.equal(readings[0].color, AIR_QUALITY_BANDS[0].color);
  // A station that reported nothing never becomes a confident "AQHI 1" row.
  const card = readingsInView(readings, null).map((reading) => reading.id);
  assert.deepEqual(card, ['eccc:zero']);
});

test('edge:air-quality: IDs and colour-band boundaries are fixed by the model', () => {
  const values = { b3: 3, b4: 4, b6: 6, b7: 7, b10: 10, b11: 11 };
  const readings = normalizeAqhiObservations(
    {
      features: Object.entries(values).map(([id, value]) =>
        observation(id, value),
      ),
    },
    stations,
    NOW,
  );
  const byId = Object.fromEntries(readings.map((row) => [row.id, row]));
  const expected = {
    'eccc:b3': ['low', '3'],
    'eccc:b4': ['moderate', '4'],
    'eccc:b6': ['moderate', '6'],
    'eccc:b7': ['high', '7'],
    'eccc:b10': ['high', '10'],
    'eccc:b11': ['very-high', '10+'],
  };
  assert.deepEqual(
    Object.keys(byId).toSorted(),
    Object.keys(expected).toSorted(),
  );
  for (const [id, [band, label]] of Object.entries(expected)) {
    assert.equal(byId[id].band, band, id);
    assert.equal(byId[id].label, label, id);
    // Both renderers take the colour from the reading itself.
    assert.equal(byId[id].color, airQualityColor(band), id);
    assert.notEqual(byId[id].color, AIR_QUALITY_UNKNOWN_COLOR, id);
  }
  // A second normalization of the same response is identical.
  assert.deepEqual(
    normalizeAqhiObservations(
      {
        features: Object.entries(values).map(([id, value]) =>
          observation(id, value),
        ),
      },
      stations,
      NOW,
    ),
    readings,
  );
});

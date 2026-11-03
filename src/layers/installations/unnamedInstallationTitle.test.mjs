import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMilitaryInstallations } from '../../data/militaryInstallationData.js';
import { UNNAMED_MILITARY_AREA } from '../../sources/openFreeMap.js';
import { setLocale } from '../../i18n/index.js';
import { installationTitle } from './classLabel.js';
import { formatAwarenessLabel } from '../../data/militaryAwarenessEngine.js';

// Unnamed installations get an English label in data ("Firing range",
// "Military land", "Military airfield"; OpenFreeMap polygons: "Military area").
// The data stays English; the map card title reads in the UI language.
const { records } = normalizeMilitaryInstallations({
  elements: [
    { type: 'node', id: 1, lat: 1, lon: 1, tags: { military: 'range' } },
    {
      type: 'way',
      id: 2,
      center: { lat: 2, lon: 2 },
      tags: { landuse: 'military' },
    },
    { type: 'node', id: 3, lat: 3, lon: 3, tags: { military: 'airfield' } },
    { type: 'node', id: 4, lat: 4, lon: 4, tags: { military: 'naval_base' } },
  ],
});
const names = [...records.map((r) => r.name), UNNAMED_MILITARY_AREA];

test('unnamed installations keep English names in data', () => {
  assert.deepEqual(names, [
    'Firing range',
    'Military land',
    'Military airfield',
    'Naval base',
    'Military area',
  ]);
});

test('unnamed installation card title reads in the UI language', () => {
  try {
    for (const locale of ['es', 'ru']) {
      setLocale(locale);
      for (const name of names) {
        const shown = installationTitle(name);
        assert.ok(shown, `${locale}: "${name}" has a title`);
        assert.notEqual(
          shown,
          name,
          `${locale}: "${name}" is shown in English`,
        );
      }
      // A mapped name is shown as it is.
      assert.equal(installationTitle('Fort Bragg'), 'Fort Bragg');
    }
  } finally {
    setLocale('en');
  }
});

test('English card titles are unchanged', () => {
  setLocale('en');
  for (const name of names) assert.equal(installationTitle(name), name);
  assert.equal(installationTitle(''), '');
});

test('the Contacts line names an unnamed installation in the UI language', () => {
  try {
    setLocale('en');
    for (const name of names)
      assert.equal(formatAwarenessLabel({ id: 'osm-1', name }), name);
    for (const locale of ['es', 'ru']) {
      setLocale(locale);
      for (const name of names)
        assert.equal(
          formatAwarenessLabel({ id: 'osm-1', name }),
          installationTitle(name),
        );
      assert.equal(
        formatAwarenessLabel({ id: 'osm-2', name: 'Fort Bragg' }),
        'Fort Bragg',
      );
      assert.equal(formatAwarenessLabel({ callsign: 'RCH123 ' }), 'RCH123');
    }
  } finally {
    setLocale('en');
  }
});

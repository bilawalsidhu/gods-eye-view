import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale, translateKnown } from './index.js';

// Layers keep these status texts as English data, and the panels show them
// through translateKnown, so each needs an entry in every catalog.
const SITES = [
  ['../layers/streetLevel/index.js', 'loading coverage...'],
  ['../layers/firms/ingestion.js', 'live feed unavailable'],
  ['../layers/bikeshare/controls.js', 'GBFS fetch error'],
  [
    '../layers/streetLevel/viewerHost.js',
    'Open the Street Level panel to view imagery',
  ],
  ['../layers/streetLevel/viewerHost.js', 'Image could not be opened'],
  ['../layers/satellites/ingestion.js', 'CelesTrak unreachable'],
  [
    '../layers/streetLevel/providers/mapillary/policy.js',
    'Coverage requests are being rate-limited — they resume on their own',
  ],
  ['../layers/alpr/index.js', 'Camera source temporarily unavailable'],
  ['../layers/perimeters/index.js', 'Perimeter source unavailable'],
  ['../layers/recentImagery/index.js', 'Imagery catalog unavailable'],
  ['../layers/installations/ingestion.js', 'Installation context unavailable'],
  ['../layers/earthquakes/index.js', 'Earthquake source unavailable'],
  ['../layers/submarineCables/ingestion.js', 'TeleGeography load failed'],
  ['../layers/vessels/ingestion.js', 'AIS live load failed'],
  ['../layers/vessels/lifecycle.js', 'AIS live load failed'],
  ['../layers/wind/index.js', 'Wind unavailable'],
  ['../layers/wind/source.js', 'Wind request timed out'],
  ['../layers/wind/source.js', 'Malformed wind manifest'],
  ['../layers/wind/source.js', 'Malformed wind grid'],
  ['../layers/wind/fields.js', 'Temperature field unavailable'],
  ['../layers/wind/fields.js', 'Mean sea level pressure field unavailable'],
];

// A fallback that reaches the panel must be marked, or `npm run i18n` cannot
// see it and the catalog entry would be pruned as unused.
for (const [file, text] of SITES) {
  test(`"${text}" in ${file} is marked`, () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(
      new RegExp(
        String.raw`\b(?:msg|t)\(\s*'${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
      ).test(source),
      `${text} is not marked in ${file}`,
    );
  });
}

for (const locale of ['es', 'ru']) {
  for (const [file, text] of SITES) {
    test(`${locale}: "${text}" from ${file} is translated`, () => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.ok(source.includes(`'${text}'`), `literal not found in ${file}`);
      setLocale(locale);
      try {
        assert.notEqual(translateKnown(text), text);
      } finally {
        setLocale('en');
      }
    });
  }
}

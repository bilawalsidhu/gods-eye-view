// Every class the bundled OSM names pack can put on a record has a
// catalog entry, so the selected card shows it in the UI language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale, getCatalog } from '../../i18n/index.js';
import { installationClassLabel } from './classLabel.js';

const pack = JSON.parse(
  readFileSync(
    new URL(
      '../../data/local_data/osm_military_names/names.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

setLocale('en');
const englishLabel = Object.fromEntries(
  pack.classes.map((c) => [c, installationClassLabel(c)]),
);

for (const locale of ['es', 'ru']) {
  test(`every names-pack class is in the ${locale} catalog`, () => {
    const catalog = getCatalog(locale);
    const missing = pack.classes.filter(
      (c) => catalog[`installation class|${englishLabel[c]}`] === undefined,
    );
    assert.deepEqual(
      missing,
      [],
      `no ${locale} entry for: ${missing.join(', ')}`,
    );
  });
}

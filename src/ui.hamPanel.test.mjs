import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isValidGrid } from './data/maidenhead.js';
import { normalizeTxGrid } from './data/hamPropagationLogic.js';

const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

/** The PROP tab's grid rejection rule, exactly as written in ui.js commitGrid. */
const panelRejectsGrid = (value) => !isValidGrid(value) || value.length < 4;

test('PROP tab rejects a grid only when setVoacap would (isValidGrid + 4-char minimum)', () => {
  assert.match(ui, /import \{ isValidGrid \} from '\.\/data\/maidenhead\.js';/);
  const commitGrid = ui.match(/const commitGrid = \(\) => \{[\s\S]*?\n    \};/);
  assert.ok(commitGrid, 'commitGrid must exist in _initHamRadioPanel');
  assert.match(commitGrid[0], /const rejected = !isValidGrid\(value\) \|\| value\.length < 4;/);
  assert.doesNotMatch(commitGrid[0], /applied\?\.txGrid !== value/, 'must not compare the applied 4-char square with the raw input');
  assert.match(commitGrid[0], /if \(rejected\) \{\s*this\._hamNote\(els\.propNote, `\$\{value\} is not a Maidenhead grid/);
  assert.match(commitGrid[0], /else if \(value\.length > 4\) \{\s*this\._hamNote\(els\.propNote, `Using \$\{value\.slice\(0, 4\)\}/);

  // The panel's verdict must agree with the layer's normalizeTxGrid for every
  // shape a user can type: 4- and 6-character grids are applied (never
  // flagged), fields and garbage are rejected.
  const cases = [
    ['JO32', false],
    ['JO32AB', false],
    ['FN31PR', false],
    ['jo32ab'.toUpperCase(), false],
    ['JO32ZZ', true],
    ['JO', true],
    ['J', true],
    ['ZZ99', true],
    ['JO3', true],
    ['12345', true],
    ['NOT A GRID', true],
  ];
  for (const [value, rejected] of cases) {
    assert.equal(panelRejectsGrid(value), rejected, `panel verdict for ${value}`);
    assert.equal(normalizeTxGrid(value) === null, rejected, `normalizeTxGrid verdict for ${value}`);
  }
});

test('TUNE NEAR SPOTTER and beacon TUNE hold an in-flight flag that survives re-renders', () => {
  assert.match(ui, /this\._hamTuneInFlight = false;\s*this\._hamBeaconTuneInFlight = false;/, 'flags initialised in the constructor');

  const tuneNear = ui.match(/async _hamTuneNearSpotter\(\) \{[\s\S]*?\n  \}\n/);
  assert.ok(tuneNear, '_hamTuneNearSpotter must exist');
  assert.match(tuneNear[0], /if \(this\._hamTuneInFlight\) return;/);
  assert.match(tuneNear[0], /this\._hamTuneInFlight = true;\s*if \(els\.spotsTune\) els\.spotsTune\.disabled = true;/);
  assert.match(tuneNear[0], /\} finally \{\s*this\._hamTuneInFlight = false;\s*if \(els\.spotsTune\) els\.spotsTune\.disabled = !this\._hamStates\['dx-spots'\]\?\.selectedId;/);
  assert.match(ui, /if \(els\.spotsTune\) els\.spotsTune\.disabled = !canAct \|\| Boolean\(this\._hamTuneInFlight\);/, 'dx-spots re-render must respect the in-flight flag');
  assert.match(ui, /if \(els\.spotsRefine\) els\.spotsRefine\.disabled = !canAct;/, 'refine is left alone (the layer dedupes it)');

  const tuneBeacon = ui.match(/async _hamTuneBeacon\(call, band\) \{[\s\S]*?\n  \}\n/);
  assert.ok(tuneBeacon, '_hamTuneBeacon must exist');
  assert.match(tuneBeacon[0], /if \(this\._hamBeaconTuneInFlight\) return;/);
  assert.match(tuneBeacon[0], /this\._hamBeaconTuneInFlight = true;\s*for \(const entry of this\._hamBeaconRows\?\.values\(\) \|\| \[\]\) \{\s*if \(entry\.action\) entry\.action\.disabled = true;/);
  assert.match(tuneBeacon[0], /try \{\s*const result = await hamBeaconsLayer\.tuneBeacon\(call, band, \{ origin: 'user' \}\);/);
  assert.match(tuneBeacon[0], /\} finally \{\s*this\._hamBeaconTuneInFlight = false;\s*this\._renderHamLayer\('ham-beacons'\);/);
  assert.match(ui, /if \(entry\.action\) entry\.action\.disabled = !life\.interactive \|\| Boolean\(this\._hamBeaconTuneInFlight\);/, 'beacon ticker re-render must respect the in-flight flag');
});

test('share/panel state restores the ham tab and propagation overlays it captures', () => {
  const build = ui.match(/_buildSharePanelState\(\) \{[\s\S]*?\n  \}\n/);
  assert.ok(build, '_buildSharePanelState must exist');
  assert.match(build[0], /entry\.tab = this\._hamTab;/);
  assert.match(build[0], /entry\.propagation = \{\s*grayline: Boolean\(prop\.overlays\?\.grayline\),\s*aurora: Boolean\(prop\.overlays\?\.aurora\),\s*ionosondes: Boolean\(prop\.overlays\?\.ionosondes\),\s*voacap: Boolean\(prop\.overlays\?\.voacap\),\s*txGrid: prop\.voacap\?\.txGrid \?\? null,\s*frequencyMhz: prop\.voacap\?\.frequencyMhz \?\? null,/);
  assert.doesNotMatch(build[0], /encodes only the collapsed bit/, 'the stale codec comment must be gone');

  const restore = ui.match(/_restorePanelState\(panelState\) \{[\s\S]*?\n  \}\n/);
  assert.ok(restore, '_restorePanelState must exist');
  assert.match(restore[0], /if \(spec\.id === HAM_RADIO_PANEL_ID && this\._hamRadioPanel\) this\._restoreHamPanelState\(state\);/);

  const restoreHam = ui.match(/_restoreHamPanelState\(state\) \{[\s\S]*?\n  \}\n/);
  assert.ok(restoreHam, '_restoreHamPanelState must exist');
  assert.match(restoreHam[0], /if \(typeof state\.tab === 'string'\) this\._setHamTab\(state\.tab\);/);
  assert.match(restoreHam[0], /for \(const key of \['grayline', 'aurora', 'ionosondes', 'voacap'\]\) \{\s*if \(typeof prop\[key\] === 'boolean'\) overlays\[key\] = prop\[key\];/);
  assert.match(restoreHam[0], /if \(Object\.keys\(overlays\)\.length\) hamPropagationLayer\.setOverlays\(overlays\);/);
  assert.match(restoreHam[0], /if \(typeof prop\.txGrid === 'string' && prop\.txGrid\.trim\(\)\) voacap\.grid = prop\.txGrid\.trim\(\);/);
  assert.match(restoreHam[0], /if \(typeof prop\.frequencyMhz === 'number' && Number\.isFinite\(prop\.frequencyMhz\)\) voacap\.frequencyMhz = prop\.frequencyMhz;/);
  assert.match(restoreHam[0], /if \(Object\.keys\(voacap\)\.length\) hamPropagationLayer\.setVoacap\(voacap\);/);
  // Restoring overlays must not force the layer on: its enabled bit travels
  // with the layer state, not the panel state.
  assert.doesNotMatch(restoreHam[0], /_ensureHamLayerEnabled|setEnabled\(/);
});

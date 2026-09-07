import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DRONE_VIEW_BRACKET_OPACITY,
  detectionBracketOpacity,
} from './detectionPresentation.js';

test('Drone View reduces only the bracket presentation multiplier', () => {
  assert.equal(DRONE_VIEW_BRACKET_OPACITY, 0.45);
  assert.equal(detectionBracketOpacity(true), 0.45);
  assert.equal(detectionBracketOpacity(false), 1);
  assert.equal(detectionBracketOpacity(undefined), 1);
});

test('detection owns and releases the Drone View lifecycle listener', async () => {
  const source = await readFile(new URL('./detection.js', import.meta.url), 'utf8');
  assert.match(source, /addEventListener\('gev:drone-view-changed', _droneViewModeListener\)/);
  assert.match(source, /removeEventListener\('gev:drone-view-changed', _droneViewModeListener\)/);
  assert.match(
    source,
    /fade \* entry\.alpha \* bracketPresentationOpacity/,
    'Drone View opacity must multiply bracket strokes only',
  );
  assert.doesNotMatch(
    source,
    /_drawCallout\(entry, fade \* bracketPresentationOpacity/,
    'Drone View bracket de-emphasis must not dim callouts',
  );
});

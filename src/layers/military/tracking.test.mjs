import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (layer) =>
  readFileSync(new URL(`../${layer}/tracking.js`, import.meta.url), 'utf8');

for (const layer of ['military', 'flights']) {
  test(`${layer}: a tracked ground station's mast is never turned`, () => {
    // The tracked billboard's rotation answers 0 for a station before any
    // course is projected on screen.
    const rotation = /rotation: \(\) => \{[\s\S]*?courseScreenRotation\(/.exec(
      source(layer),
    )?.[0];
    assert.ok(rotation, 'the tracked billboard turns by a rotation callback');
    assert.match(
      rotation,
      /if \(tracked\.klass === 'station'\) return 0;\s*const projected = courseScreenRotation\(/,
    );
  });
}

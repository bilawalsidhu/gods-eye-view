import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readSource } from './testSupport/readSource.js';

/**
 * Contract: the headless rAF-starvation helpers have ONE implementation
 * (scripts/lib/headlessFrames.mjs). The failure class they solve — a settled
 * headless scene produces no BeginFrames, so rAF-scheduled work sits pending
 * through any wall-clock sleep — is subtle enough that a second, drifting
 * inline copy in a suite is how the bug comes back (PLAN.md Phase 11, R1).
 */

const HELPERS_DIR = '../scripts';
const LIB_SPEC = '../scripts/lib/headlessFrames.mjs';
const HELPER_NAMES = ['installCompositorFramePump', 'waitForLaidOutRect', 'waitForStable'];

const suiteFiles = readdirSync(new URL(HELPERS_DIR, import.meta.url))
  .filter((name) => name.startsWith('qa-') && name.endsWith('.mjs'));

test('the headlessFrames library exports the full determinism surface', async () => {
  const lib = await import(LIB_SPEC);
  for (const name of HELPER_NAMES) {
    assert.equal(typeof lib[name], 'function', `missing export: ${name}`);
  }
});

test('the library documents the failure class it exists to prevent', () => {
  const source = readSource(LIB_SPEC, import.meta.url);
  assert.match(source, /BeginFrames/, 'header must name the BeginFrame mechanism');
  assert.match(source, /NEVER sleep-then-measure/, 'header must carry the polling rule');
});

for (const file of suiteFiles) {
  test(`${file} imports the shared helpers instead of redefining them`, () => {
    const source = readSource(`${HELPERS_DIR}/${file}`, import.meta.url);
    for (const name of HELPER_NAMES) {
      const redefines = new RegExp(
        `(async\\s+)?function\\s+${name}\\s*\\(|const\\s+${name}\\s*=`,
      );
      assert.doesNotMatch(
        source,
        redefines,
        `${file} defines ${name} inline — import it from scripts/lib/headlessFrames.mjs so the pump/rect contract cannot drift`,
      );
    }
    // Any suite driving the pump binding must install it through the library
    // import (comments that merely mention the binding don't count — the
    // same line shape as a real use is what the rule keys on).
    if (/window\.__qaForceCompositorFrame\s*\?\.\(\)/.test(source)) {
      assert.match(
        source,
        /from '\.\/lib\/headlessFrames\.mjs'/,
        `${file} calls the pump binding but does not import its installer`,
      );
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { detectionBracketAlpha } from './detectionPolicy.js';

// Exercise the actual renderer's admission and paint expressions. A sweep is
// appearance only: it must not reshuffle candidates at the cohort cutoff.
const source = readFileSync(new URL('./detection.js', import.meta.url), 'utf8');
const alphaBlock = source.match(
  /const admissionAlpha = detectionBracketAlpha\([\s\S]*?const bracketAlpha = [^;]+;/,
)?.[0];
const bandAssignment = source.match(/obj\._cohortBand\s*=\s*[^;]+;/)?.[0];

test('Sonar changes paint alpha without changing detection cohort admission', () => {
  assert.ok(alphaBlock, 'renderer separates admission from paint');
  assert.ok(bandAssignment);
  for (const cyberMapActive of [false, true]) {
    for (const type of ['AIR', 'SAT', 'SEA']) {
      for (const keyholeAlpha of [0, 0.01, 0.125, 0.5, 0.999, 1]) {
        const alpha = detectionBracketAlpha(
          type,
          keyholeAlpha,
          0.35,
          cyberMapActive,
        );
        const expectedBand = alpha >= 0.999 ? 8 : Math.floor(alpha * 8);
        for (const sonarFactor of [0.01, 0.12, 0.5, 1]) {
          const state = {
            obj: { type },
            keyholeAlpha,
            keyholeOutsideOpacity: 0.35,
            cyberMapActive,
            sonarFactor,
            detectionBracketAlpha,
          };
          vm.runInNewContext(
            alphaBlock + bandAssignment + '; result = bracketAlpha;',
            state,
          );
          assert.equal(state.obj._cohortBand, expectedBand);
          assert.equal(state.result, alpha * sonarFactor);
        }
      }
    }
  }
});

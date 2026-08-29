// Contract tests for the visual-style shader modules (src/styles/*.js).
//
// ui.js consumes these modules through a specific contract:
//   - `uniforms[uName] = uMeta.default` seeds every Cesium PostProcessStage,
//     so each uniform entry needs a numeric `default`;
//   - the DISPLAY param sliders read `uMeta.label` (text), `uMeta.min` and
//     `uMeta.max` (bounds, and `max <= 1` switches the slider step to 0.01),
//     so each entry needs those three fields with min <= default <= max;
//   - the stage always writes `intensity`, and auto-detects animated shaders
//     by the literal `uniform float time` — both must appear in the GLSL;
//   - every declared custom uniform must exist in the GLSL, and every
//     non-built-in GLSL uniform must have a `uniforms` entry, or the pass
//     renders with an unset (zero) input.
// A shader that violates any of this compiles fine and silently renders wrong,
// which is exactly the class of regression these tests exist for.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retroShader } from './retro.js';
import { animeShader } from './anime.js';
import { noirShader } from './noir.js';
import { snowShader } from './snow.js';
import { nightVisionShader } from './surveillance.js';
import { thermalShader } from './thermal.js';

const STYLES = [
  ['retro', retroShader],
  ['anime', animeShader],
  ['noir', noirShader],
  ['snow', snowShader],
  ['surveillance', nightVisionShader],
  ['thermal', thermalShader],
];

// Cesium-injected or ui.js-managed uniforms that intentionally have no entry
// in a shader's `uniforms` metadata map.
const NON_CUSTOM_UNIFORMS = new Set([
  'colorTexture',
  'colorTextureDimensions',
  'intensity',
  'time',
]);

function declaredUniforms(fragmentShader) {
  const found = [];
  const re = /uniform\s+(?:float|vec[234]|int|sampler2D)\s+(\w+)\s*;/g;
  for (let m = re.exec(fragmentShader); m; m = re.exec(fragmentShader)) {
    found.push(m[1]);
  }
  return found;
}

for (const [expectedName, shader] of STYLES) {
  test(`${expectedName}: declares identity, metadata, and GLSL`, () => {
    assert.equal(shader.name, expectedName, 'registry key must match module name');
    assert.equal(typeof shader.fragmentShader, 'string');
    assert.ok(shader.fragmentShader.trim().length > 0, 'fragmentShader must be non-empty');
    assert.equal(typeof shader.uniforms, 'object');
    assert.ok(shader.uniforms && Object.keys(shader.uniforms).length > 0, 'uniforms metadata required');
  });

  test(`${expectedName}: uniform metadata is slider-ready`, () => {
    for (const [uniformName, meta] of Object.entries(shader.uniforms)) {
      assert.equal(typeof meta.default, 'number', `${uniformName}.default must be numeric`);
      assert.ok(Number.isFinite(meta.default), `${uniformName}.default must be finite`);
      assert.equal(typeof meta.min, 'number', `${uniformName}.min must be numeric`);
      assert.equal(typeof meta.max, 'number', `${uniformName}.max must be numeric`);
      assert.ok(meta.min < meta.max, `${uniformName}: min must be below max`);
      assert.ok(
        meta.default >= meta.min && meta.default <= meta.max,
        `${uniformName}: default ${meta.default} outside [${meta.min}, ${meta.max}]`,
      );
      assert.equal(typeof meta.label, 'string', `${uniformName}.label must be a string`);
      assert.ok(meta.label.trim().length > 0, `${uniformName}.label must be non-empty (slider text)`);
    }
  });

  test(`${expectedName}: GLSL declares what the consumer sets`, () => {
    const glsl = shader.fragmentShader;
    for (const required of ['colorTexture', 'intensity', 'v_textureCoordinates']) {
      assert.ok(glsl.includes(required), `fragmentShader must reference ${required}`);
    }
    const declared = declaredUniforms(glsl);
    const declaredSet = new Set(declared);
    for (const uniformName of Object.keys(shader.uniforms)) {
      assert.ok(
        declaredSet.has(uniformName),
        `uniform "${uniformName}" has metadata but no GLSL declaration`,
      );
    }
    for (const uniformName of declared) {
      if (NON_CUSTOM_UNIFORMS.has(uniformName)) continue;
      assert.ok(
        Object.hasOwn(shader.uniforms, uniformName),
        `GLSL uniform "${uniformName}" has no uniforms entry (would render unset)`,
      );
    }
  });

  test(`${expectedName}: every declared GLSL uniform is unique`, () => {
    const declared = declaredUniforms(shader.fragmentShader);
    assert.equal(
      declared.length,
      new Set(declared).size,
      'duplicate uniform declaration would fail GLSL compilation',
    );
  });
}

test('style names are unique across the registry', () => {
  const names = STYLES.map(([, shader]) => shader.name);
  assert.equal(new Set(names).size, names.length);
});

test('ui.js registers every style module in its STYLES map', () => {
  // ui.js is browser-only (imports Cesium), so the wiring is pinned as a
  // source contract instead of an import: each style's name must appear as a
  // key of the STYLES literal, otherwise the module ships dead.
  const uiSource = readFileSync(
    fileURLToPath(new URL('../ui.js', import.meta.url)),
    'utf8',
  );
  const stylesLine = uiSource.split('\n').find((line) => line.startsWith('const STYLES = '));
  assert.ok(stylesLine, 'ui.js must declare the STYLES registry literal');
  for (const [name] of STYLES) {
    assert.ok(
      new RegExp(`\\b${name}\\s*:`).test(stylesLine),
      `style "${name}" is not registered in ui.js STYLES`,
    );
  }
});

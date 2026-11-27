import assert from 'node:assert/strict';
import test from 'node:test';
import { nightVisionShader } from './surveillance.js';
import { thermalShader } from './thermal.js';

/**
 * Texture reads one pixel costs: every `texture(` call, multiplied by the
 * trip counts of the `for (int v = a; v <= b; v++)` loops around it.
 */
function textureReads(source) {
  const token =
    /for \(int \w+ = (-?\d+); \w+ <= (-?\d+); \w+\+\+\) \{|texture\(|[{}]/g;
  const scopes = [1];
  let reads = 0;
  for (const match of source.matchAll(token)) {
    const inside = scopes.at(-1);
    if (match[0] === 'texture(') reads += inside;
    else if (match[0] === '}') scopes.pop();
    else if (match[0] === '{') scopes.push(inside);
    else scopes.push(inside * (Number(match[2]) - Number(match[1]) + 1));
  }
  assert.deepEqual(scopes, [1], 'braces balance');
  return reads;
}

function readsPerPixel(shader) {
  return [shader, ...(shader.passes || [])].reduce(
    (total, pass) => total + textureReads(pass.fragmentShader),
    0,
  );
}

test('the read counter multiplies nested loop trips', () => {
  const nested = `void main() {
    for (int y = -5; y <= 5; y++) {
      for (int x = -5; x <= 5; x++) { a += texture(t, uv).r; }
    }
    b = texture(t, uv);
  }`;
  assert.equal(textureReads(nested), 122);
});

test('night vision blooms with two 11-sample sums, not 121 samples', () => {
  // 11 in the row pass, 11 column sums and the pixel itself.
  assert.equal(readsPerPixel(nightVisionShader), 23);
});

test('FLIR blooms with two 9-sample sums, not 81 samples', () => {
  // 9 in the row pass, 9 column sums, the 5x5 soft blur, the pixel itself
  // and the centre sample behind the temperature readout.
  assert.equal(readsPerPixel(thermalShader), 45);
});

for (const shader of [nightVisionShader, thermalShader])
  test(`${shader.name}: each pass reads style uniforms and feeds the main shader`, () => {
    assert.ok(shader.passes.length > 0);
    for (const pass of shader.passes) {
      for (const [, uniform] of pass.fragmentShader.matchAll(
        /uniform float (\w+);/g,
      ))
        assert.ok(
          uniform in shader.uniforms ||
            uniform === 'intensity' ||
            uniform === 'time',
          `${uniform} is a style uniform`,
        );
      assert.match(
        shader.fragmentShader,
        new RegExp(`uniform sampler2D ${pass.texture};`),
      );
      assert.match(
        shader.fragmentShader,
        new RegExp(`texture\\(${pass.texture},`),
      );
    }
  });

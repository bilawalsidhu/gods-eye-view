import test from 'node:test';
import assert from 'node:assert/strict';
import { shadowFrame } from './besselian.js';
import { MOON_RADIUS, SHADOW_SHADER, sunAndMoon } from './shadow.js';
import { createEclipseElementsSource } from './source.js';

const catalog = await createEclipseElementsSource().getCatalog();

// Words GLSL ES 3.00 keeps for itself: a variable named with one fails to
// compile, and a shader that fails to compile stops the whole scene.
const RESERVED = [
  'active',
  'asm',
  'cast',
  'class',
  'common',
  'double',
  'enum',
  'extern',
  'external',
  'filter',
  'fixed',
  'goto',
  'half',
  'hvec2',
  'inline',
  'input',
  'interface',
  'long',
  'namespace',
  'noinline',
  'output',
  'partition',
  'public',
  'resource',
  'short',
  'sizeof',
  'static',
  'superp',
  'template',
  'this',
  'typedef',
  'union',
  'unsigned',
  'using',
  'volatile',
];

test('the shader names no variable with a word GLSL reserves', () => {
  const code = SHADOW_SHADER.replace(/\/\/[^\n]*/g, '');
  const declared = [
    ...code.matchAll(
      /\b(?:float|int|bool|vec[234]|mat[234])\s+([A-Za-z_]\w*)/g,
    ),
  ].map((match) => match[1]);
  assert.ok(declared.length > 40);
  assert.deepEqual(
    declared.filter((name) => RESERVED.includes(name)),
    [],
  );
});

test('every uniform the shader declares is one it uses', () => {
  const uniforms = [...SHADOW_SHADER.matchAll(/uniform \w+ (\w+);/g)].map(
    (match) => match[1],
  );
  assert.ok(uniforms.length >= 14);
  for (const name of uniforms)
    assert.ok(
      SHADOW_SHADER.split(name).length > 2,
      `${name} is declared but never read`,
    );
});

test('the cones place the Moon and the Sun along the axis at their true sizes and distances', () => {
  const eclipse = catalog.find(({ id }) => id === '2027-08-02');
  const frame = shadowFrame(eclipse, eclipse.greatestMs);
  const { sun, moon } = sunAndMoon(frame);
  assert.equal(moon[3], MOON_RADIUS);
  const height = (body) =>
    (body[0] - frame.origin[0]) * frame.k[0] +
    (body[1] - frame.origin[1]) * frame.k[1] +
    (body[2] - frame.origin[2]) * frame.k[2];
  // The Moon about 56 Earth radii up the axis (it was near perigee), the Sun
  // about 23,500 (one astronomical unit), 109 Earth radii across.
  assert.ok(Math.abs(height(moon) - 56) < 2);
  assert.ok(Math.abs(height(sun) / 23_455 - 1) < 0.03);
  assert.ok(Math.abs(sun[3] / 109.1 - 1) < 0.03);
  // Seen from the Earth's centre the Moon is the larger disc: a total eclipse.
  assert.ok(moon[3] / height(moon) > sun[3] / height(sun));
});

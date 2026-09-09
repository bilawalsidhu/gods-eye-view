import test from 'node:test';
import assert from 'node:assert/strict';
import { sonarShader } from './sonar.js';

test('sonarShader: metadata and name contract', () => {
  assert.equal(typeof sonarShader, 'object');
  assert.equal(sonarShader.name, 'sonar');
  assert.equal(typeof sonarShader.fragmentShader, 'string');
  assert.ok(sonarShader.fragmentShader.length > 100);
});

test('sonarShader: uniforms schema and bounds validity', () => {
  const { uniforms } = sonarShader;
  assert.ok(uniforms, 'uniforms object must be defined');

  const expectedUniforms = ['sweepSpeed', 'ringDensity', 'persistence', 'gain'];
  for (const name of expectedUniforms) {
    const u = uniforms[name];
    assert.ok(u, `uniform ${name} must exist`);
    assert.equal(typeof u.default, 'number', `${name}.default must be number`);
    assert.equal(typeof u.min, 'number', `${name}.min must be number`);
    assert.equal(typeof u.max, 'number', `${name}.max must be number`);
    assert.equal(typeof u.label, 'string', `${name}.label must be string`);
    assert.ok(u.min <= u.default, `${name}.min must be <= default`);
    assert.ok(u.default <= u.max, `${name}.default must be <= max`);
  }
});

test('sonarShader: GLSL fragment shader declares required uniforms and ins/outs', () => {
  const glsl = sonarShader.fragmentShader;

  assert.match(glsl, /uniform\s+sampler2D\s+colorTexture;/);
  assert.match(glsl, /uniform\s+vec2\s+colorTextureDimensions;/);
  assert.match(glsl, /uniform\s+float\s+intensity;/);
  assert.match(glsl, /uniform\s+float\s+time;/);
  assert.match(glsl, /uniform\s+float\s+sweepSpeed;/);
  assert.match(glsl, /uniform\s+float\s+ringDensity;/);
  assert.match(glsl, /uniform\s+float\s+persistence;/);
  assert.match(glsl, /uniform\s+float\s+gain;/);
  assert.match(glsl, /in\s+vec2\s+v_textureCoordinates;/);
  assert.match(glsl, /out_FragColor\s*=/);
});

test('sonarShader: contains rotational sweep and distance calculations', () => {
  const glsl = sonarShader.fragmentShader;
  assert.ok(glsl.includes('atan('), 'must compute angular coordinate');
  assert.ok(glsl.includes('length('), 'must compute radial distance');
  assert.ok(glsl.includes('smoothstep('), 'must use smoothstep for soft edges');
  assert.ok(glsl.includes('exp('), 'must use exponential falloff for phosphor decay');
});

test('sonarShader: integration with sharelink parameters and URL tokens', async () => {
  const sharelinkModule = await import('../sharelink.js');
  const fileContent = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../sharelink.js', import.meta.url), 'utf8')
  );
  assert.match(fileContent, /sonar:\s*'sonar'/);
  assert.match(fileContent, /sonar:\s*Object\.freeze\(\[/);
  assert.match(fileContent, /key:\s*'sweepSpeed'/);
  assert.match(fileContent, /key:\s*'ringDensity'/);
  assert.match(fileContent, /key:\s*'persistence'/);
  assert.match(fileContent, /key:\s*'gain'/);
});

test('sonarShader: integration with voice actions grammar and aliases', async () => {
  const fileContent = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('../voice/gevActions.js', import.meta.url), 'utf8')
  );
  assert.match(fileContent, /'sonar'/);
  assert.match(fileContent, /raw === 'sonar' \|\| raw === 'tactical sonar'/);
});


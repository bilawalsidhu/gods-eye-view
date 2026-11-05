import assert from 'node:assert/strict';
import test from 'node:test';
import { HalfFloatType, SRGBColorSpace, Texture } from 'three';
import { STYLES } from '../../ui/visualPresets.js';
import {
  GevStylesPass,
  createStylesPort,
  navaraStyleFragmentShader,
  styleUniformDefaults,
  styleUniformNames,
  visibleStyles,
} from './stylePass.js';

const buffer = (name, width = 640, height = 400) => ({
  name,
  width,
  height,
  texture: Object.assign(new Texture(), { type: HalfFloatType, name }),
});

test('every app style compiles into the Navara prelude with Cesium names mapped', () => {
  assert.deepEqual(Object.keys(STYLES), [
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
  ]);
  for (const [name, shader] of Object.entries(STYLES)) {
    const source = navaraStyleFragmentShader(shader.fragmentShader);
    // One real main(): the prelude's, calling the style's renamed one.
    assert.equal(source.match(/void\s+main\s*\(\s*\)/g).length, 1, name);
    assert.equal(source.match(/void\s+gevStyleMain\s*\(\s*\)/g).length, 1);
    assert.match(source, /gevStyleMain\(\);/);
    // Every read of the input is the encoding wrapper's; the only bare
    // texture() is the wrapper's own.
    const reads = shader.fragmentShader.match(/\btexture\s*\(/g)?.length ?? 0;
    assert.ok(reads > 0, `${name} reads its input`);
    assert.equal(
      source.match(/\bgevStyleTexture\s*\(/g).length,
      reads + 1,
      `${name}: every texture() goes through the encode`,
    );
    assert.equal(source.match(/\btexture\s*\(/g).length, 1, name);
    // Cesium's output name is a plain global the prelude resolves; the
    // decode is the inverse of the encode (sharpen.js's exact transfer).
    assert.match(source, /^vec4 out_FragColor;$/m);
    assert.match(source, /out vec4 gevFragColor;/);
    assert.match(source, /gevDecodeSrgb\(display\)/);
    assert.match(source, /1\.0\/2\.4/);
    assert.match(source, /vec3\(2\.4\)/);
    assert.match(source, /#if GEV_DISPLAY_OUTPUT/);
    assert.doesNotMatch(source, /czm_/);
  }
});

test('the prelude refuses shaders it cannot map', () => {
  assert.throws(() => navaraStyleFragmentShader('void foo() {}'), TypeError);
  assert.throws(
    () =>
      navaraStyleFragmentShader(
        'void main() { out_FragColor = czm_gammaCorrect(vec4(1.0)); }',
      ),
    TypeError,
  );
  assert.throws(
    () => navaraStyleFragmentShader('void main() {} void main() {}'),
    TypeError,
  );
});

test('style uniforms: the shader parameters, plus time for an animated one', () => {
  assert.deepEqual(styleUniformNames(STYLES.retro), [
    'pixelation',
    'distortion',
    'instability',
    'time',
  ]);
  assert.deepEqual(styleUniformNames(STYLES.noir), [
    'contrastAmt',
    'grainAmt',
    'vignetteAmt',
  ]);
  assert.ok(styleUniformNames(STYLES.thermal).includes('time'));
  assert.ok(styleUniformNames(STYLES.surveillance).includes('time'));
  assert.ok(!styleUniformNames(STYLES.anime).includes('time'));
  assert.deepEqual(styleUniformDefaults(STYLES.thermal), {
    sensitivity: 0.75,
    bloom: 0.65,
    mode: 0,
    pixelation: 1.5,
    palette: 0,
    time: 0,
  });
});

test('visible styles keep the stage order and skip faded ones', () => {
  const states = new Map([
    ['noir', { intensity: 0.6, uniforms: {} }],
    ['retro', { intensity: 0.4, uniforms: {} }],
    ['anime', { intensity: 0.0005, uniforms: {} }],
  ]);
  assert.deepEqual(
    visibleStyles(Object.keys(STYLES), states).map(([name]) => name),
    ['retro', 'noir'],
  );
  assert.deepEqual(visibleStyles(Object.keys(STYLES), new Map()), []);
});

function renderer() {
  const draws = [];
  let target;
  return {
    draws,
    outputColorSpace: SRGBColorSpace,
    setRenderTarget(next) {
      target = next;
    },
    render(scene) {
      const material = scene.children[0].material;
      draws.push({
        target: target === null ? null : target.name || 'scratch',
        material: material.name,
        input: material.uniforms.colorTexture.value?.name || 'scratch',
        dimensions: material.uniforms.colorTextureDimensions.value.toArray(),
        intensity: material.uniforms.intensity.value,
        uniforms: Object.fromEntries(
          Object.entries(material.uniforms)
            .filter(([key]) => !key.startsWith('color'))
            .map(([key, { value }]) => [key, value]),
        ),
        display: material.defines.GEV_DISPLAY_OUTPUT,
      });
    },
  };
}

test('the pass maps a style state onto its material and draws input to output', () => {
  const states = new Map();
  const pass = new GevStylesPass({
    shaders: STYLES,
    visible: () => visibleStyles(Object.keys(STYLES), states),
  });
  const gl = renderer();
  const input = buffer('input');
  const output = buffer('output');
  pass.render(gl, input, output);
  assert.equal(gl.draws.length, 0);
  assert.equal(pass.needsSwap, false, 'nothing drawn keeps the input');

  states.set('thermal', {
    intensity: 0.75,
    uniforms: { palette: 1, time: 12.5 },
  });
  pass.render(gl, input, output);
  assert.equal(pass.needsSwap, true);
  assert.equal(gl.draws.length, 1);
  const [draw] = gl.draws;
  assert.equal(draw.material, 'GevStyle_thermal');
  assert.equal(draw.target, 'output');
  assert.equal(draw.input, 'input');
  assert.deepEqual(draw.dimensions, [640, 400]);
  assert.equal(draw.intensity, 0.75);
  assert.equal(draw.uniforms.palette, 1);
  assert.equal(draw.uniforms.time, 12.5);
  // Defaults for what the state does not name.
  assert.equal(draw.uniforms.sensitivity, 0.75);
  assert.equal(draw.display, 0);
  pass.dispose();
});

test('a crossfade draws both styles in stage order through one scratch target', () => {
  const states = new Map([
    ['noir', { intensity: 0.3, uniforms: {} }],
    ['surveillance', { intensity: 0.7, uniforms: { time: 3 } }],
    ['retro', { intensity: 0.2, uniforms: { pixelation: 2 } }],
  ]);
  const pass = new GevStylesPass({
    shaders: STYLES,
    visible: () => visibleStyles(Object.keys(STYLES), states),
  });
  const gl = renderer();
  pass.render(gl, buffer('input'), buffer('output'));
  assert.deepEqual(
    gl.draws.map(({ material, input, target }) => [material, input, target]),
    [
      ['GevStyle_retro', 'input', 'scratch'],
      ['GevStyle_surveillance', 'scratch', 'input'],
      ['GevStyle_noir', 'input', 'output'],
    ],
  );
  assert.equal(pass.scratch.width, 640);
  assert.equal(pass.scratch.texture.type, HalfFloatType);
  pass.dispose();
  assert.equal(pass.scratch, null);
});

test('drawn to the screen, the pass keeps display RGB', () => {
  const states = new Map([['anime', { intensity: 1, uniforms: {} }]]);
  const pass = new GevStylesPass({
    shaders: STYLES,
    visible: () => visibleStyles(Object.keys(STYLES), states),
  });
  pass.renderToScreen = true;
  const gl = renderer();
  pass.render(gl, buffer('input'), buffer('output'));
  assert.equal(gl.draws[0].target, null);
  assert.equal(gl.draws[0].display, 1);
  pass.dispose();
});

function fakeView() {
  const view = { added: [], updates: [], deleted: 0 };
  view.addEffect = (config) => {
    const handle = {
      config,
      update(next) {
        view.updates.push(next);
      },
      delete() {
        view.deleted++;
      },
    };
    view.added.push(handle);
    return handle;
  };
  return view;
}

test('the styles port adds the pass once, hides it at 0 and fades the stars with Anime', () => {
  const view = fakeView();
  const dimmed = [];
  const port = createStylesPort(view, {
    shaders: STYLES,
    onStarsDimmed: (amount) => dimmed.push(amount),
  });
  assert.deepEqual(port.names, Object.keys(STYLES));
  assert.deepEqual(port.uniformNames('noir'), styleUniformNames(STYLES.noir));
  assert.deepEqual(port.defaults('retro'), styleUniformDefaults(STYLES.retro));
  port.set('noir', { intensity: 0, uniforms: {} });
  assert.equal(view.added.length, 0, 'a view that never filters has no pass');
  port.set('noir', { intensity: 1, uniforms: { grainAmt: 0.2 } });
  assert.equal(view.added.length, 1);
  assert.equal(port.passShown(), true);
  const { controller } = view.added[0].config.gevStyles;
  assert.deepEqual(controller.visible(), [
    ['noir', { intensity: 1, uniforms: { grainAmt: 0.2 } }],
  ]);
  port.set('anime', { intensity: 0.5, uniforms: {} });
  port.set('noir', { intensity: 0, uniforms: {} });
  port.set('anime', { intensity: 0, uniforms: {} });
  assert.deepEqual(view.updates, [{ visible: false }]);
  assert.equal(port.passShown(), false);
  port.set('retro', { intensity: 1, uniforms: {} });
  assert.deepEqual(view.updates, [{ visible: false }, { visible: true }]);
  assert.equal(view.added.length, 1, 'shown again, not added again');
  assert.deepEqual(dimmed, [0.5, 0]);
  port.set('anime', { intensity: 0.9, uniforms: {} });
  port.destroy();
  assert.equal(view.deleted, 1);
  assert.deepEqual(dimmed, [0.5, 0, 0.9, 0], 'destroy brings the stars back');
});

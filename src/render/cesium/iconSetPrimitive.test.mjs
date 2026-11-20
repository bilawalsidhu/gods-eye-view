import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import * as Cesium from 'cesium';
import { createIconSet } from '../../data/iconSet.js';
import { IconSetPrimitive } from './iconSetPrimitive.js';

// Node has no WebGL context to report line-width limits.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

/** The primitive's draw commands, made without a context: programs stubbed. */
function commandsOf(options = {}) {
  const made = [];
  const fromCache = Cesium.ShaderProgram.fromCache;
  Cesium.ShaderProgram.fromCache = ({ fragmentShaderSource }) => {
    const program = { defines: fragmentShaderSource.defines, destroy() {} };
    made.push(program);
    return program;
  };
  try {
    const primitive = new IconSetPrimitive({
      set: createIconSet(),
      renderTime: () => Cesium.JulianDate.now(),
      ...options,
    });
    primitive._createCommands(undefined);
    return { primitive, programs: made };
  } finally {
    Cesium.ShaderProgram.fromCache = fromCache;
  }
}

test('a translucent set draws one blended pass in order, as translucent billboards do', () => {
  const { primitive } = commandsOf({ translucent: () => true });
  const single = primitive._singleCommand;
  // In the opaque pass, out of the translucent pass's order-independent blend.
  assert.equal(single.pass, Cesium.Pass.OPAQUE);
  const state = single.renderState;
  // Equal depths pass, so the last row drawn is on top.
  assert.equal(state.depthTest.enabled, true);
  assert.equal(state.depthTest.func, Cesium.DepthFunction.LESS_OR_EQUAL);
  assert.equal(state.depthMask, true);
  assert.equal(state.blending.enabled, true);
  // Every fragment drawn: neither pass's alpha split.
  assert.deepEqual(single.shaderProgram.defines, []);
  assert.equal(primitive.drawsBlend('translucent'), true);
  assert.equal(primitive.drawsBlend('additive'), false);
});

test('by default the set draws an opaque pass and a translucent one, and draws no blend itself', () => {
  const { primitive } = commandsOf();
  const [opaque, translucent] = primitive._commands;
  assert.equal(opaque.pass, Cesium.Pass.OPAQUE);
  assert.deepEqual(opaque.shaderProgram.defines, ['OPAQUE']);
  assert.equal(opaque.renderState.depthTest.func, Cesium.DepthFunction.LESS);
  assert.equal(translucent.pass, Cesium.Pass.TRANSLUCENT);
  assert.deepEqual(translucent.shaderProgram.defines, ['TRANSLUCENT']);
  assert.equal(translucent.renderState.depthMask, false);
  assert.equal(primitive.drawsBlend('translucent'), false);
});

test('an over-depth row writes a depth of exactly 0, which a depth pick ignores', () => {
  // Shaders do not compile under node: this reads the fragment shader's
  // source. A depth past the near plane (as 1.0001 through
  // czm_writeLogDepth was) is a surface to Cesium's depth pick, a near
  // plane's distance from the camera, and the wheel stops zooming with an
  // icon under the canvas centre (scripts/qa-zoom-under-icon.mjs).
  const source = fs.readFileSync(
    new URL('./iconSetPrimitive.js', import.meta.url),
    'utf8',
  );
  const [vertex, fragment] = source
    .slice(source.indexOf('const VERTEX_SHADER'))
    .split('const FRAGMENT_SHADER')
    .map((shader) => shader.replace(/\/\/.*$/gm, '')); // comments out
  assert.match(
    fragment,
    /if \(v_overDepth > 0\.5\) gl_FragDepth = 0\.0;\s+else czm_writeLogDepth\(v_depthFromNearPlusOne\);/,
  );
  // The vertex shader flags the row and leaves its log depth alone.
  assert.match(
    vertex,
    /gl_Position\.z = -gl_Position\.w;[^}]*v_overDepth = 1\.0;/,
  );
  assert.doesNotMatch(vertex, /v_depthFromNearPlusOne\s*=/);
});

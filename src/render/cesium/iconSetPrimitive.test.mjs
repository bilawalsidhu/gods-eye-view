import assert from 'node:assert/strict';
import test from 'node:test';
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
  Cesium.ShaderProgram.fromCache = ({
    vertexShaderSource,
    fragmentShaderSource,
  }) => {
    const program = {
      defines: fragmentShaderSource.defines,
      fragmentSources: fragmentShaderSource.sources,
      vertexSources: vertexShaderSource.sources,
      destroy() {},
    };
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

test('an icon over depth writes a depth of exactly zero, so picks and zoom see through it', () => {
  const { programs } = commandsOf();
  const fragment = programs[0].fragmentSources.join('\n');
  const vertex = programs[0].vertexSources.join('\n');
  // Cesium's pickPosition skips a depth of exactly zero; any depth above it
  // reads the icon as a surface at the camera and wheel zoom stops there.
  assert.match(fragment, /if \(v_overDepth > 0\.5\) gl_FragDepth = 0\.0;/);
  assert.match(vertex, /v_overDepth = 1\.0;/);
  assert.doesNotMatch(vertex, /v_depthFromNearPlusOne = 1\.0001/);
});

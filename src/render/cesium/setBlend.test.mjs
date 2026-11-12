import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { ADDITIVE_PASS, blendCommands, blendHost } from './setBlend.js';

const { Pass, BlendingState, RenderState } = Cesium;

// Node has no WebGL context to report line-width limits.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

const opaqueState = RenderState.fromCache({
  depthTest: { enabled: true },
  depthMask: true,
});
const translucentState = RenderState.fromCache({
  depthTest: { enabled: true },
  depthMask: false,
  blending: BlendingState.ALPHA_BLEND,
});
const groundState = RenderState.fromCache({
  stencilTest: { enabled: true },
  depthMask: false,
  blending: BlendingState.ALPHA_BLEND,
});

const bounds = new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 1);
const commands = () => [
  new Cesium.DrawCommand({
    pass: Pass.OPAQUE,
    renderState: opaqueState,
    boundingVolume: bounds,
  }),
  new Cesium.DrawCommand({
    pass: Pass.TRANSLUCENT,
    renderState: translucentState,
    boundingVolume: bounds,
  }),
  new Cesium.DrawCommand({
    pass: Pass.TERRAIN_CLASSIFICATION,
    renderState: groundState,
  }),
];

const drawn = (list) =>
  list.map((c) => ({
    pass: c.pass,
    blending: c.renderState.blending.enabled
      ? c.renderState.blending.functionDestinationRgb ===
        Cesium.BlendFunction.ONE
        ? 'add'
        : 'alpha'
      : 'none',
    depthMask: c.renderState.depthMask,
    depthTest: c.renderState.depthTest.enabled,
    stencil: c.renderState.stencilTest.enabled,
  }));

test('no blend draws commands as given', () => {
  const list = commands();
  const before = drawn(list);
  blendCommands(list, 0, undefined);
  assert.deepEqual(drawn(list), before);
});

test('opaque: every command opaque, unblended, with depth writes; ground keeps its pass', () => {
  const list = commands();
  blendCommands(list, 0, 'opaque');
  assert.deepEqual(
    drawn(list).map(({ pass, blending, depthMask }) => [
      pass,
      blending,
      depthMask,
    ]),
    [
      [Pass.OPAQUE, 'none', true],
      [Pass.OPAQUE, 'none', true],
      [Pass.TERRAIN_CLASSIFICATION, 'none', false],
    ],
  );
  assert.equal(list[2].renderState.stencilTest.enabled, true, 'stencil kept');
});

test('translucent: alpha-blended without depth writes, even opaque ones', () => {
  const list = commands();
  blendCommands(list, 0, 'translucent');
  assert.deepEqual(
    drawn(list).map(({ pass, blending, depthMask }) => [
      pass,
      blending,
      depthMask,
    ]),
    [
      [Pass.TRANSLUCENT, 'alpha', false],
      [Pass.TRANSLUCENT, 'alpha', false],
      [Pass.TERRAIN_CLASSIFICATION, 'alpha', false],
    ],
  );
});

test('additive: added after opaque commands, without depth writes, still depth-tested', () => {
  const list = commands();
  blendCommands(list, 0, 'additive');
  assert.deepEqual(
    drawn(list).map(({ pass, blending, depthMask, depthTest }) => [
      pass,
      blending,
      depthMask,
      depthTest,
    ]),
    [
      [ADDITIVE_PASS, 'add', false, true],
      [ADDITIVE_PASS, 'add', false, true],
      [Pass.TERRAIN_CLASSIFICATION, 'add', false, false],
    ],
  );
});

test('a changed blend turns commands again from what they were given', () => {
  const list = commands();
  const kept = list.slice();
  blendCommands(list, 0, 'additive');
  blendCommands(kept.slice(), 0, 'opaque');
  assert.equal(kept[1].pass, Pass.OPAQUE);
  blendCommands(kept.slice(), 0, undefined);
  assert.deepEqual(
    kept.map((c) => [c.pass, c.renderState]),
    [
      [Pass.OPAQUE, opaqueState],
      [Pass.TRANSLUCENT, translucentState],
      [Pass.TERRAIN_CLASSIFICATION, groundState],
    ],
    'back as given',
  );
  // A state the host gives anew is what it now has.
  const fresh = RenderState.fromCache({
    depthMask: true,
    cull: { enabled: true },
  });
  blendCommands(kept.slice(), 0, 'translucent');
  kept[0].renderState = fresh;
  blendCommands(kept.slice(0, 1), 0, undefined);
  assert.equal(kept[0].renderState, fresh);
});

test('a blended host turns only its own commands, in render passes, each frame', () => {
  const [mine, ,] = commands();
  const other = new Cesium.DrawCommand({
    pass: Pass.OPAQUE,
    renderState: opaqueState,
    boundingVolume: bounds,
  });
  let blend = 'translucent';
  const host = blendHost(
    { update: (fs) => fs.commandList.push(mine) },
    () => blend,
  );
  const frame = (render = true) => {
    const frameState = { commandList: [other], passes: { render } };
    host.update(frameState);
    return frameState.commandList;
  };
  assert.equal(frame(false)[1].pass, Pass.OPAQUE, 'picks untouched');
  const list = frame();
  assert.equal(list[0].pass, Pass.OPAQUE, 'not its own');
  assert.equal(list[1].pass, Pass.TRANSLUCENT);
  blend = undefined;
  assert.equal(frame()[1].pass, Pass.OPAQUE, 'the next frame, as given');
  assert.equal(
    blendHost(host, () => 'opaque'),
    host,
    'wrapped once',
  );
});

test('a host that draws the blend itself keeps its commands as made, and others turn back', () => {
  const [mine] = commands();
  let blend = 'additive';
  let drawsIt = false;
  const host = blendHost(
    {
      update: (fs) => fs.commandList.push(mine),
      drawsBlend: (asked) => drawsIt && asked === 'translucent',
    },
    () => blend,
  );
  const frame = () => {
    const frameState = { commandList: [], passes: { render: true } };
    host.update(frameState);
    return frameState.commandList[0];
  };
  const given = { renderState: mine.renderState, pass: mine.pass };
  assert.notEqual(frame().renderState, given.renderState, 'turned to additive');
  blend = 'translucent';
  drawsIt = true;
  const drawn = frame();
  assert.equal(drawn.renderState, given.renderState, 'as made');
  assert.equal(drawn.pass, given.pass);
  blend = undefined;
  drawsIt = false;
  assert.equal(frame().renderState, given.renderState, 'still as made');
});

test('a collection built translucent keeps its commands where it draws them', () => {
  const [mine] = commands();
  const host = blendHost(
    {
      blendOption: Cesium.BlendOption.TRANSLUCENT,
      update: (fs) => fs.commandList.push(mine),
    },
    () => 'translucent',
  );
  const frameState = { commandList: [], passes: { render: true } };
  host.update(frameState);
  assert.equal(frameState.commandList[0].pass, Pass.OPAQUE, 'blended in order');
  assert.equal(frameState.commandList[0].renderState, opaqueState);
});

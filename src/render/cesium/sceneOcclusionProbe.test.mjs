import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  PROBE_MAX_CONTROL_FAILURES,
  PROBE_MAX_FRUSTUMS,
  PROBE_MAX_PENDING_FRAMES,
  PROBE_MAX_PER_FRAME,
  PROBE_RETRY_AFTER_MS,
  PROBE_VERTEX_SHADER,
  SYNC_READ_INTERVAL_MS,
  SceneOcclusionProbe,
  readSceneDepthSource,
} from './sceneOcclusionProbe.js';
import {
  createFakeDepthScene,
  createFakeGl,
  depthImage,
  viewDistanceToDepth,
} from './fixtures/fakeDepthScene.mjs';

const NEAR = 1;
const FAR = 100_000;

/** Left half a wall 400 m away, right half ground 500 m away. */
function wallImage(width, height, logDepth = true, wall = 400) {
  return depthImage(width, height, (column) =>
    viewDistanceToDepth(column < width / 2 ? wall : 500, NEAR, FAR, logDepth),
  );
}

function wallScene({ width = 64, height = 32, logDepth = true, gl } = {}) {
  return createFakeDepthScene({
    gl,
    logDepth,
    aspectRatio: width / height,
    ranges: [
      { near: NEAR, far: FAR, image: wallImage(width, height, logDepth) },
    ],
  });
}

const behindWall = { x: -250, y: 0, z: -500 };
const onStreet = { x: 250, y: 0, z: -500 };
const contact = () => ({
  lastHiddenAt: Number.NEGATIVE_INFINITY,
  pending: false,
});

/** One frame: collect, queue the given contacts, draw. */
function frame(probe, scene, now, tests = []) {
  probe.beginFrame(scene, now);
  const accepted = tests.map(([entry, position]) => probe.add(entry, position));
  probe.endFrame();
  return accepted;
}

test('a test is drawn at once and answered on a later frame, without anything being read back', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const hidden = contact();
  const shown = contact();
  assert.equal(probe.mode, 'off');
  assert.deepEqual(
    frame(probe, scene, 1000, [
      [hidden, behindWall],
      [shown, onStreet],
    ]),
    [true, true],
  );
  assert.equal(probe.mode, 'async');
  assert.equal(probe.lastFrameTests, 2);
  assert.equal(hidden.pending, true);
  assert.equal(
    gl.counts.queries,
    3,
    'the control point and one query per contact',
  );
  assert.equal(gl.counts.draws, 3);

  // Frames pass before the GPU has answered: nothing changes, nothing waits.
  frame(probe, scene, 1016);
  frame(probe, scene, 1032);
  assert.equal(hidden.pending, true);
  assert.equal(hidden.lastHiddenAt, Number.NEGATIVE_INFINITY);
  assert.equal(gl.counts.resultReads, 0);
  assert.equal(gl.counts.readPixels, 0);

  gl.finishGpu();
  frame(probe, scene, 1048);
  assert.equal(hidden.pending, false);
  assert.equal(shown.pending, false);
  assert.equal(hidden.answered, true);
  assert.equal(shown.answered, true);
  assert.equal(hidden.lastHiddenAt, 1000, 'dated to its test frame');
  assert.equal(shown.lastHiddenAt, Number.NEGATIVE_INFINITY);
  assert.equal(gl.counts.readPixels, 0, 'depth never leaves the GPU');
});

test('queries are reused, and every depth range is tested nearest first', () => {
  const width = 64;
  const height = 32;
  const farNear = 900;
  const farFar = 5_000_000;
  const scene = createFakeDepthScene({
    aspectRatio: 2,
    ranges: [
      // Near range: the wall on the left, nothing drawn on the right.
      {
        near: NEAR,
        far: 1000,
        image: depthImage(width, height, (column) =>
          column < width / 2 ? viewDistanceToDepth(400, NEAR, 1000, true) : 1,
        ),
      },
      // Far range: ground 20 km away, drawn with its near plane pulled in.
      {
        near: farNear,
        far: farFar,
        image: depthImage(width, height, () =>
          viewDistanceToDepth(20_000, farNear * 0.9999, farFar, true),
        ),
      },
    ],
  });
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const cases = [
    [contact(), { x: -7500, y: 0, z: -15_000 }, true], // behind the near wall
    [contact(), { x: 7500, y: 0, z: -15_000 }, false], // above the far ground
    [contact(), { x: 15_000, y: 0, z: -30_000 }, true], // under the far ground
    [contact(), { x: -150, y: 0, z: -300 }, false], // in front of the wall
  ];
  for (let round = 0; round < 3; round++) {
    frame(
      probe,
      scene,
      round * 100,
      cases.map(([entry, position]) => [entry, position]),
    );
    gl.finishGpu();
    frame(probe, scene, round * 100 + 16);
    for (const [entry, , hidden] of cases) {
      assert.equal(entry.pending, false);
      assert.equal(entry.lastHiddenAt === round * 100, hidden);
    }
  }
  assert.equal(gl.liveQueries.size, 5, 'five queries serve every round');
  const source = readSceneDepthSource(scene);
  assert.equal(source.frustums[1].near, farNear * 0.9999);
});

test('standard depth scenes are tested too', () => {
  const scene = wallScene({ logDepth: false });
  const probe = new SceneOcclusionProbe();
  const hidden = contact();
  const shown = contact();
  frame(probe, scene, 0, [
    [hidden, behindWall],
    [shown, onStreet],
  ]);
  scene.context._gl.finishGpu();
  frame(probe, scene, 16);
  assert.equal(hidden.lastHiddenAt, 0);
  assert.equal(shown.lastHiddenAt, Number.NEGATIVE_INFINITY);
});

test('every binding the renderer relies on is left as found', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const found = {
    read: { image: null },
    draw: { image: null },
    units: [{}, {}, {}, {}, {}, {}, {}, {}],
    unit: 5,
    array: {},
    vertexArray: {},
    program: { uniforms: {} },
    scissor: true,
    viewport: [12, 34, 640, 480],
  };
  Object.assign(gl.state, found, { units: [...found.units] });
  const probe = new SceneOcclusionProbe();
  const hidden = contact();
  frame(probe, scene, 0, [[hidden, behindWall]]);
  for (const key of [
    'read',
    'draw',
    'unit',
    'array',
    'vertexArray',
    'program',
    'scissor',
  ])
    assert.equal(gl.state[key], found[key], key);
  assert.deepEqual(gl.state.units, found.units);
  assert.deepEqual(gl.state.viewport, [12, 34, 640, 480]);
  // The scissor test and the offset viewport would both have kept the points
  // off the target, so neither was in force for them: the control point drew,
  // and the answer counts.
  gl.finishGpu();
  frame(probe, scene, 16);
  assert.equal(hidden.lastHiddenAt, 0);
  assert.equal(gl.state.scissor, true);
});

test('a contact outside the frame, or past the frame budget, is not taken', () => {
  const scene = wallScene();
  const probe = new SceneOcclusionProbe();
  probe.beginFrame(scene, 0);
  const outside = contact();
  assert.equal(probe.add(outside, { x: -1100, y: 0, z: -500 }), false);
  assert.equal(probe.add(outside, { x: 0, y: 0, z: 500 }), false);
  assert.equal(outside.pending, false);
  const taken = [];
  for (let i = 0; i < PROBE_MAX_PER_FRAME + 10; i++)
    taken.push(probe.add(contact(), onStreet));
  probe.endFrame();
  assert.equal(taken.filter(Boolean).length, PROBE_MAX_PER_FRAME);
  assert.equal(taken.lastIndexOf(true), PROBE_MAX_PER_FRAME - 1);
  assert.equal(scene.context._gl.counts.queries, PROBE_MAX_PER_FRAME + 1);
});

test('a frame with nothing to test touches nothing', () => {
  let reads = 0;
  const probe = new SceneOcclusionProbe({
    readSource: () => {
      reads++;
      return null;
    },
  });
  frame(probe, {}, 0);
  frame(probe, {}, 16);
  assert.equal(reads, 0);
  assert.equal(probe.lastFrameTests, 0);
});

test('no depth source: nothing is tested and nothing is in flight', () => {
  const broken = [
    null,
    {},
    { ...wallScene(), mode: Cesium.SceneMode.SCENE2D },
    { ...wallScene(), mode: Cesium.SceneMode.COLUMBUS_VIEW },
    { ...wallScene(), useDepthPicking: false },
    { ...wallScene(), _environmentState: { useGlobeDepthFramebuffer: false } },
    { ...wallScene(), view: { frustumCommandsList: [], pickDepths: [] } },
    { ...wallScene(), view: undefined },
    (() => {
      const scene = wallScene();
      scene.context.depthTexture = false;
      return scene;
    })(),
    (() => {
      const scene = wallScene();
      scene.camera.frustum = { width: 1000, aspectRatio: 2 }; // orthographic
      return scene;
    })(),
    (() => {
      const scene = wallScene();
      scene.camera.frustum.xOffset = 10;
      return scene;
    })(),
    (() => {
      const scene = wallScene();
      scene.view.pickDepths[0].framebuffer = undefined; // not drawn yet
      return scene;
    })(),
    // Whether depth is logarithmic, unknown: decoding it the wrong way would
    // put every surface in front of every contact.
    { ...wallScene(), frameState: {} },
    { ...wallScene(), frameState: { useLogDepth: 1 } },
    { ...wallScene(), frameState: undefined },
    (() => {
      const scene = wallScene();
      Object.defineProperty(scene, 'view', {
        get() {
          throw new Error('renderer changed shape');
        },
      });
      return scene;
    })(),
  ];
  for (const scene of broken) {
    assert.equal(readSceneDepthSource(scene), null);
    const probe = new SceneOcclusionProbe();
    const entry = contact();
    assert.deepEqual(frame(probe, scene, 0, [[entry, behindWall]]), [false]);
    assert.equal(probe.mode, 'off');
    assert.equal(entry.pending, false);
  }
});

test('depth that comes and goes is picked up frame by frame', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  scene.useDepthPicking = false;
  assert.deepEqual(frame(probe, scene, 0, [[entry, behindWall]]), [false]);
  assert.equal(probe.mode, 'off');
  scene.useDepthPicking = true;
  assert.deepEqual(frame(probe, scene, 16, [[entry, behindWall]]), [true]);
  assert.equal(probe.mode, 'async');
  gl.finishGpu();
  frame(probe, scene, 32);
  assert.equal(entry.lastHiddenAt, 16);
});

test('depth ranges past the limit are left out, nearest kept', () => {
  const image = wallImage(8, 8);
  const ranges = [];
  for (let i = 0; i < PROBE_MAX_FRUSTUMS + 2; i++)
    ranges.push({ near: 10 ** i, far: 10 ** (i + 1), image });
  const source = readSceneDepthSource(createFakeDepthScene({ ranges }));
  assert.equal(source.frustums.length, PROBE_MAX_FRUSTUMS);
  assert.equal(source.textures.length, PROBE_MAX_FRUSTUMS);
  assert.equal(source.frustums[0].near, 1);
});

test('a control point that does not draw voids its batch; a run of them stands the probe down for a while', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  // Something outside the probe's reach stops every point from drawing, so
  // every query reads "nothing drew", which would otherwise mean "hidden".
  gl.state.drawsLand = false;
  let now = 0;
  for (let i = 0; i < PROBE_MAX_CONTROL_FAILURES; i++) {
    const entry = contact();
    assert.deepEqual(frame(probe, scene, now, [[entry, behindWall]]), [true]);
    gl.finishGpu();
    now += 16;
    frame(probe, scene, now);
    assert.equal(entry.pending, false);
    assert.equal(entry.lastHiddenAt, Number.NEGATIVE_INFINITY, 'not believed');
    assert.notEqual(entry.answered, true, 'and not a first answer either');
    now += 16;
  }
  assert.equal(probe.mode, 'off');
  const stoodDownAt = now - 16;
  assert.deepEqual(frame(probe, scene, now, [[contact(), behindWall]]), [
    false,
  ]);
  assert.deepEqual(
    frame(probe, scene, stoodDownAt + PROBE_RETRY_AFTER_MS - 1, [
      [contact(), behindWall],
    ]),
    [false],
  );
  // The cause has passed: the probe picks up where it left off.
  gl.state.drawsLand = true;
  const entry = contact();
  const retryAt = stoodDownAt + PROBE_RETRY_AFTER_MS;
  assert.deepEqual(frame(probe, scene, retryAt, [[entry, behindWall]]), [true]);
  assert.equal(probe.mode, 'async');
  gl.finishGpu();
  frame(probe, scene, retryAt + 16);
  assert.equal(entry.lastHiddenAt, retryAt);
  assert.equal(entry.answered, true);

  // One good batch in between resets the count.
  const healthy = new SceneOcclusionProbe();
  const other = wallScene();
  for (let i = 0; i < 6; i++) {
    other.context._gl.state.drawsLand = i % 2 === 1;
    frame(healthy, other, i * 32, [[contact(), onStreet]]);
    other.context._gl.finishGpu();
    frame(healthy, other, i * 32 + 16);
  }
  assert.equal(healthy.mode, 'async');
});

test('a shader that does not compile, or a WebGL call that throws, stands the probe down cleanly', () => {
  let scene = wallScene();
  // Only the fragment shader fails: the vertex shader that did compile must
  // not be left behind.
  scene.context._gl.state.compiles = (type) =>
    type !== scene.context._gl.FRAGMENT_SHADER;
  let probe = new SceneOcclusionProbe();
  let entry = contact();
  assert.deepEqual(frame(probe, scene, 0, [[entry, behindWall]]), [false]);
  assert.equal(probe.mode, 'off');
  assert.equal(entry.pending, false);
  // Nothing half-made is kept, and the same context is never asked again:
  // compiling is a wait on the GPU process and would fail the same way.
  let gl = scene.context._gl;
  assert.equal(gl.liveShaders.size, 0, 'no shader left behind');
  let shaderCalls = 0;
  const createShader = gl.createShader;
  gl.createShader = (...args) => {
    shaderCalls++;
    return createShader(...args);
  };
  for (const now of [PROBE_RETRY_AFTER_MS + 16, 5 * PROBE_RETRY_AFTER_MS])
    assert.deepEqual(frame(probe, scene, now, [[entry, behindWall]]), [false]);
  assert.equal(shaderCalls, 0);
  assert.equal(probe.mode, 'off');

  // A draw that throws part-way: bindings restored, no query left behind.
  scene = wallScene();
  gl = scene.context._gl;
  const found = {
    draw: { image: null },
    program: { uniforms: {} },
    viewport: [0, 0, 800, 600],
  };
  Object.assign(gl.state, found, { scissor: true });
  let draws = 0;
  const drawArrays = gl.drawArrays;
  gl.drawArrays = (...args) => {
    if (++draws === 2) throw new Error('driver');
    return drawArrays(...args);
  };
  probe = new SceneOcclusionProbe();
  entry = contact();
  const other = contact();
  assert.deepEqual(
    frame(probe, scene, 0, [
      [entry, behindWall],
      [other, onStreet],
    ]),
    [true, true],
  );
  assert.equal(entry.pending, false, 'released when the draw failed');
  assert.equal(other.pending, false);
  assert.equal(probe.mode, 'off');
  assert.equal(gl.state.draw, found.draw);
  assert.equal(gl.state.program, found.program);
  assert.deepEqual(gl.state.viewport, found.viewport);
  assert.equal(gl.state.scissor, true);
  assert.equal(gl.liveQueries.size, 0);
  assert.deepEqual(frame(probe, scene, 16, [[entry, behindWall]]), [false]);

  scene = wallScene();
  gl = scene.context._gl;
  probe = new SceneOcclusionProbe();
  entry = contact();
  frame(probe, scene, 0, [[entry, behindWall]]);
  gl.getQueryParameter = () => {
    throw new Error('driver');
  };
  frame(probe, scene, 16);
  assert.equal(entry.pending, false);
  assert.equal(probe.mode, 'off');
});

test('a frame that never reaches its end leaves no contact waiting for an answer', () => {
  const scene = wallScene();
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  probe.beginFrame(scene, 0);
  assert.equal(probe.add(entry, behindWall), true);
  assert.equal(entry.pending, true);
  // The painter threw before endFrame; the next frame starts clean.
  probe.beginFrame(scene, 16);
  assert.equal(entry.pending, false);
  assert.equal(probe.add(entry, behindWall), true);
  probe.endFrame();
  assert.equal(
    scene.context._gl.counts.queries,
    2,
    'only the second frame drew',
  );
});

test('an answer collected late is dated to its test, not to its arrival', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  frame(probe, scene, 1000, [[entry, behindWall]]);
  gl.finishGpu();
  // The overlay paints nothing for 20 seconds, then resumes.
  frame(probe, scene, 21_000);
  assert.equal(entry.pending, false);
  assert.equal(entry.lastHiddenAt, 1000);
  // An older answer never overwrites a newer one.
  entry.lastHiddenAt = 30_000;
  frame(probe, scene, 22_000, [[entry, behindWall]]);
  gl.finishGpu();
  frame(probe, scene, 22_016);
  assert.equal(entry.lastHiddenAt, 30_000);
});

test('samplers for depth ranges not in use point at a texture that is bound', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  // Whatever the renderer left on the other units is not the probe's to read.
  gl.state.units = [null, null, null, null, null, null, null, null];
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  frame(probe, scene, 0, [[entry, behindWall]]);
  gl.finishGpu();
  frame(probe, scene, 16);
  assert.equal(
    entry.lastHiddenAt,
    0,
    'the draw was valid, so the answer counts',
  );
  assert.deepEqual(gl.state.units, [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
});

test('reset drops tests in flight but keeps the GPU objects for next time', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  frame(probe, scene, 0, [[entry, behindWall]]);
  probe.reset();
  assert.equal(entry.pending, false);
  assert.equal(probe.mode, 'off');
  assert.equal(gl.counts.deleted, 0);
  gl.finishGpu();
  frame(probe, scene, 16);
  assert.equal(
    entry.lastHiddenAt,
    Number.NEGATIVE_INFINITY,
    'the dropped answer is not applied',
  );
  frame(probe, scene, 32, [[entry, behindWall]]);
  assert.equal(probe.mode, 'async');
  assert.equal(gl.liveQueries.size, 2, 'queries are reused, not recreated');
});

test('a lost context drops what was in flight and starts over when it returns', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  frame(probe, scene, 0, [[entry, behindWall]]);
  gl.state.lost = true;
  assert.deepEqual(frame(probe, scene, 16, [[contact(), behindWall]]), [false]);
  assert.equal(entry.pending, false);
  assert.equal(probe.mode, 'off');
  gl.state.lost = false;
  assert.deepEqual(frame(probe, scene, 32, [[entry, behindWall]]), [true]);
  gl.finishGpu();
  frame(probe, scene, 48);
  assert.equal(entry.lastHiddenAt, 32);
});

test('queries that are never answered are abandoned', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  frame(probe, scene, 0, [[entry, behindWall]]);
  for (let i = 1; i <= PROBE_MAX_PENDING_FRAMES; i++)
    frame(probe, scene, i * 16);
  assert.equal(entry.pending, true);
  frame(probe, scene, (PROBE_MAX_PENDING_FRAMES + 1) * 16);
  assert.equal(entry.pending, false);
  assert.equal(entry.lastHiddenAt, Number.NEGATIVE_INFINITY);
  assert.equal(gl.liveQueries.size, 0);
  assert.equal(probe.mode, 'async', 'and the next contact is tested as usual');
});

test('every batch times out on its own, however many are queued ahead of it', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const probe = new SceneOcclusionProbe();
  const entries = [];
  // Ten frames each start a batch; the GPU answers none of them.
  for (let i = 0; i < 10; i++) {
    const entry = contact();
    entries.push(entry);
    frame(probe, scene, i * 16, [[entry, behindWall]]);
  }
  for (let i = 10; i <= PROBE_MAX_PENDING_FRAMES; i++)
    frame(probe, scene, i * 16);
  assert.ok(entries.every((entry) => entry.pending));
  // Ten more frames and all ten have been dropped, not one every 120 frames.
  for (let i = 1; i <= 10; i++)
    frame(probe, scene, (PROBE_MAX_PENDING_FRAMES + i) * 16);
  assert.ok(entries.every((entry) => !entry.pending));
  assert.equal(gl.liveQueries.size, 0);
});

test('a target that cannot be made leaves nothing behind, and the next try starts from scratch', () => {
  const scene = wallScene();
  const gl = scene.context._gl;
  const complete = gl.checkFramebufferStatus;
  gl.checkFramebufferStatus = () => 0;
  const probe = new SceneOcclusionProbe();
  const entry = contact();
  assert.deepEqual(frame(probe, scene, 0, [[entry, behindWall]]), [false]);
  assert.equal(probe.mode, 'off');
  assert.equal(gl.counts.deleted, 5, 'program, array, buffer, target');
  // Memory pressure passes; after the stand-down the probe builds it all again.
  gl.checkFramebufferStatus = complete;
  assert.deepEqual(
    frame(probe, scene, PROBE_RETRY_AFTER_MS, [[entry, behindWall]]),
    [true],
  );
  assert.equal(probe.mode, 'async');
  gl.finishGpu();
  frame(probe, scene, PROBE_RETRY_AFTER_MS + 16);
  assert.equal(entry.lastHiddenAt, PROBE_RETRY_AFTER_MS);
});

test('a new WebGL context, or destroy, releases everything', () => {
  const probe = new SceneOcclusionProbe();
  const first = wallScene();
  const entry = contact();
  frame(probe, first, 0, [[entry, behindWall]]);
  const second = wallScene();
  const again = contact();
  assert.deepEqual(frame(probe, second, 16, [[again, behindWall]]), [true]);
  assert.equal(entry.pending, false, 'the first context will never answer');
  assert.equal(first.context._gl.liveQueries.size, 0);
  assert.equal(
    first.context._gl.counts.deleted,
    5,
    'program, array, buffer, target',
  );
  probe.destroy();
  assert.equal(again.pending, false);
  assert.equal(second.context._gl.liveQueries.size, 0);
  assert.equal(probe.mode, 'off');
});

test('without queries (WebGL 1) depth is read back synchronously, at most every interval, and the mode says so', () => {
  const gl = createFakeGl({ webgl2: false });
  const scene = wallScene({ gl });
  assert.equal(scene.context.webgl2, false);
  const sceneFramebuffer = { image: null };
  gl.state.read = sceneFramebuffer;
  gl.state.draw = sceneFramebuffer;
  const probe = new SceneOcclusionProbe();
  const hidden = contact();
  const shown = contact();
  assert.deepEqual(
    frame(probe, scene, 1000, [
      [hidden, behindWall],
      [shown, onStreet],
      [contact(), { x: -1100, y: 0, z: -500 }],
    ]),
    [true, true, false],
  );
  assert.equal(probe.mode, 'sync');
  assert.equal(gl.counts.readPixels, 1);
  assert.equal(gl.state.read, sceneFramebuffer);
  assert.equal(gl.state.draw, sceneFramebuffer);
  assert.equal(hidden.lastHiddenAt, 1000, 'answered on the spot');
  assert.equal(hidden.pending, false);
  assert.equal(shown.answered, true);
  assert.equal(shown.lastHiddenAt, Number.NEGATIVE_INFINITY);
  // Frames inside the interval answer from the read already made.
  frame(probe, scene, 1000 + SYNC_READ_INTERVAL_MS - 1, [[hidden, behindWall]]);
  assert.equal(gl.counts.readPixels, 1);
  assert.equal(hidden.lastHiddenAt, 1000 + SYNC_READ_INTERVAL_MS - 1);
  frame(probe, scene, 1000 + SYNC_READ_INTERVAL_MS, [[hidden, behindWall]]);
  assert.equal(gl.counts.readPixels, 2);
});

test('the shader decodes depth the way the CPU decode does', () => {
  // The fake context stands in for the shader, so pin the parts of the source
  // the two must agree on: the unpack weights, both depth formulas, the
  // nearest-range-first order and the comparison.
  const source = PROBE_VERTEX_SHADER.replace(/\s+/g, ' ');
  assert.match(
    source,
    /vec4\(1\.0, 1\.0 \/ 255\.0, 1\.0 \/ 65025\.0, 1\.0 \/ 16581375\.0\)/,
  );
  assert.match(source, /if \(depth <= 0\.0 \|\| depth >= 1\.0\) return -1\.0;/);
  assert.match(
    source,
    /near \+ exp2\(depth \* log2\(far - near \+ 1\.0\)\) - 1\.0/,
  );
  assert.match(source, /near \* far \/ \(far - depth \* \(far - near\)\)/);
  assert.match(
    source,
    /bool hidden = surface > 0\.0 && surface < a_contact\.z;/,
  );
  assert.ok(
    source.indexOf('u_depth0, u_near.x') < source.indexOf('u_depth1, u_near.y'),
  );
});

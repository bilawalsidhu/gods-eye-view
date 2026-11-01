import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sceneSeekState } from '../director/timeline.js';

const adapter = await import('./blenderCamera.js');
test('a portable camera manifest adapter exists', () => {
  assert.equal(typeof adapter.exportCameraManifest, 'function');
});

const origin = { lat: 0, lon: 0, height: 0 };
const pose = (changes = {}) => ({
  lat: 0,
  lon: 0,
  alt: 0,
  heading: 0,
  pitch: 0,
  roll: 0,
  ...changes,
});
const options = (changes = {}) => ({
  origin,
  fps: { numerator: 30, denominator: 1 },
  width: 1920,
  height: 1080,
  horizontalFovDegrees: 90,
  ...changes,
});
const project = (
  shots = [{ id: 'north', durationSec: 1, holdSec: 0, camera: pose() }],
) => ({
  version: 6,
  scenes: [{ id: 'scene', title: 'Synthetic cameras', shots }],
});
const near = (a, b, eps = 1e-8) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} != ${b}`));
const camera = (changes = {}, opts = {}) =>
  adapter.exportCameraManifest(
    project([{ id: 'camera', durationSec: 1, camera: pose(changes) }]),
    options(opts),
  ).frames[0];

test('cardinal cameras use Blender X right, Y up, negative Z forward', () => {
  for (const [heading, right, back] of [
    [0, [1, 0, 0], [0, -1, 0]],
    [90, [0, -1, 0], [-1, 0, 0]],
    [180, [-1, 0, 0], [0, 1, 0]],
    [270, [0, 1, 0], [1, 0, 0]],
  ]) {
    const result = camera({ heading });
    near(result.basisColumns[0], right);
    near(result.basisColumns[1], [0, 0, 1]);
    near(result.basisColumns[2], back);
  }
  near(camera({ pitch: -90 }).basisColumns[2], [0, 0, 1]);
  near(camera({ roll: 90 }).basisColumns[1], [1, 0, 0]);
});

test('ENU translation uses WGS84 meters and ellipsoid heights', () => {
  near(camera({ alt: 100 }).position, [0, 0, 100]);
  const east = camera({ lon: 0.001 }).position;
  assert.ok(Math.abs(east[0] - 111.3194907876) < 1e-6);
  assert.ok(Math.abs(east[2] + 0.0009714458) < 1e-6);
});

test('changed tangent frames and nonzero roll match an independent Cesium Camera', () => {
  const anchor = { lat: 39.7, lon: -105, height: 1600 };
  const p = pose({
    lat: 39.73,
    lon: -104.97,
    alt: 2400,
    heading: 47,
    pitch: -29,
    roll: 37,
  });
  const reference = new Cesium.Camera({
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    mapProjection: new Cesium.GeographicProjection(),
    mode: Cesium.SceneMode.SCENE3D,
  });
  reference.setView({
    destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
    orientation: {
      heading: Cesium.Math.toRadians(p.heading),
      pitch: Cesium.Math.toRadians(p.pitch),
      roll: Cesium.Math.toRadians(p.roll),
    },
  });
  const inverse = Cesium.Matrix4.inverseTransformation(
    Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.height),
    ),
    new Cesium.Matrix4(),
  );
  const arr = (v) => [v.x, v.y, v.z];
  const local = (v) =>
    arr(
      Cesium.Matrix4.multiplyByPointAsVector(
        inverse,
        v,
        new Cesium.Cartesian3(),
      ),
    );
  const actual = camera(p, { origin: anchor });
  near(actual.basisColumns[0], local(reference.rightWC));
  near(actual.basisColumns[1], local(reference.upWC));
  near(
    actual.basisColumns[2],
    local(
      Cesium.Cartesian3.negate(reference.directionWC, new Cesium.Cartesian3()),
    ),
  );
});

test('explicit horizontal lens works for landscape and portrait output', () => {
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
  ]) {
    const m = adapter.exportCameraManifest(
      project(),
      options({ width, height }),
    );
    assert.ok(Math.abs(m.camera.lensMm - 18) < 1e-10);
    assert.equal(m.camera.sensorFit, 'HORIZONTAL');
    assert.ok(
      Math.abs(m.camera.verticalFovRadians - 2 * Math.atan(height / width)) <
        1e-10,
    );
  }
});

test('anchors, cubic moves, cuts, holds and rational frame timing survive JSON round trip', () => {
  const p = project([
    {
      id: 'move',
      durationSec: 0.4,
      holdSec: 0.2,
      camera: { anchorId: 'end', heading: 10, pitch: 0, roll: 20 },
      move: {
        from: {
          ...pose({ lon: 179.999, heading: 350 }),
          altitudeReference: 'ellipsoid',
        },
        easing: 'cubic-in-out',
      },
    },
    {
      id: 'cut',
      durationSec: 0.2,
      holdSec: 0,
      camera: pose({ lon: -179.999, heading: 90 }),
    },
  ]);
  p.scenes[0].anchors = [
    {
      id: 'end',
      lat: 0,
      lon: -179.999,
      alt: 20,
      altitudeReference: 'ellipsoid',
    },
  ];
  const m = adapter.exportCameraManifest(
    p,
    options({
      origin: { lat: 0, lon: 180, height: 0 },
      fps: { numerator: 30000, denominator: 1001 },
    }),
  );
  assert.equal(m.frames.length, 24);
  assert.equal(m.source.sceneId, 'scene');
  assert.deepEqual(
    m.shots.map((s) => s.id),
    ['move', 'cut'],
  );
  assert.equal(m.shots[0].endTimeSec, 0.6000000000000001);
  assert.equal(m.frames[18].shotId, 'cut');
  assert.equal(m.frames[18].timeSec, (18 * 1001) / 30000);
  near(m.frames[12].position, m.frames[17].position);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
  assert.equal(p.scenes[0].shots[0].camera.anchorId, 'end');
});

test('invalid or ambiguous input fails before export', () => {
  for (const change of [
    { fps: { numerator: 0, denominator: 1 } },
    { horizontalFovDegrees: undefined },
    { width: 0 },
    { origin: { lat: 0, lon: NaN, height: 0 } },
    { horizontalFovDegrees: 180 },
  ]) {
    assert.throws(() =>
      adapter.exportCameraManifest(project(), options(change)),
    );
  }
  assert.throws(() => camera({ lon: 20 }), /100 km/);
  const multiple = project();
  multiple.scenes.push({ ...multiple.scenes[0], id: 'other' });
  assert.throws(
    () => adapter.exportCameraManifest(multiple, options()),
    /scene/i,
  );
  assert.throws(
    () =>
      adapter.exportCameraManifest(
        project([{ id: 'missing', camera: { heading: 0 } }]),
        options(),
      ),
    /lat|position/i,
  );
  assert.throws(
    () =>
      adapter.exportCameraManifest(
        project([{ id: 'long', camera: pose(), durationSec: 86400 }]),
        options(),
      ),
    /frame/i,
  );
});

test('projection settings cannot be silently clamped by Blender', () => {
  assert.throws(
    () => adapter.exportCameraManifest(project(), options({ width: 1 })),
    /width/,
  );
  assert.throws(
    () =>
      adapter.exportCameraManifest(
        project(),
        options({ horizontalFovDegrees: 179, sensorWidthMm: 1 }),
      ),
    /lens/i,
  );
});

test('every exported sample agrees with Director seeking at fractional shot boundaries', () => {
  const p = project([
    {
      id: 'first',
      camera: pose({ heading: 350, roll: -350 }),
      durationSec: 0.21,
      holdSec: 0.11,
    },
    {
      id: 'second',
      camera: pose({ lon: 0.001, heading: 10, roll: 350 }),
      durationSec: 0.22,
      holdSec: 0.13,
    },
  ]);
  const m = adapter.exportCameraManifest(p, options());
  assert.equal(m.frames.length, 21);
  for (const sample of m.frames) {
    const state = sceneSeekState(
      p.scenes[0],
      sample.timeSec / m.timeline.durationSec,
      (_scene, shot) => shot.durationSec + shot.holdSec,
      (_scene, shot) => shot.holdSec,
    );
    const expected = adapter.cameraPoseToEnu(state.camera, origin);
    assert.equal(sample.shotId, state.shot.id);
    near(sample.position, expected.position);
    sample.basisColumns.forEach((axis, i) =>
      near(axis, expected.basisColumns[i]),
    );
  }
});

test('CLI works in paths with spaces and refuses overwrites or invalid projection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gev camera '));
  try {
    const input = join(directory, 'saved scene.json');
    const output = join(directory, 'camera manifest.json');
    writeFileSync(input, JSON.stringify(project()));
    const script = fileURLToPath(
      new URL('../../tools/export-blender-camera.mjs', import.meta.url),
    );
    const args = [
      script,
      '--input',
      input,
      '--output',
      output,
      '--origin',
      '0,0,0',
      '--fps',
      '30000/1001',
      '--width',
      '1920',
      '--height',
      '1080',
      '--horizontal-fov-deg',
      '60',
    ];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /CAMERA_EXPORT_OK/);
    const contents = readFileSync(output, 'utf8');
    assert.equal(JSON.parse(contents).timeline.fps.denominator, 1001);
    const repeat = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(repeat.status, 1);
    assert.equal(readFileSync(output, 'utf8'), contents);
    const invalidOutput = join(directory, 'invalid.json');
    const invalid = [...args];
    invalid[invalid.indexOf(output)] = invalidOutput;
    invalid[invalid.length - 1] = '180';
    assert.equal(
      spawnSync(process.execPath, invalid, { encoding: 'utf8' }).status,
      1,
    );
    assert.equal(existsSync(invalidOutput), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary submillisecond shots retain the Director seek duration floor', () => {
  const p = project([
    { id: 'start', camera: pose(), durationSec: 0.033, holdSec: 0 },
    {
      id: 'short',
      camera: pose({ heading: 90 }),
      durationSec: 0.0005,
      holdSec: 0.1,
    },
  ]);
  const m = adapter.exportCameraManifest(p, options());
  const sample = m.frames[1];
  const state = sceneSeekState(
    p.scenes[0],
    sample.timeSec / m.timeline.durationSec,
    (_scene, shot) => shot.durationSec + shot.holdSec,
    (_scene, shot) => shot.holdSec,
  );
  const expected = adapter.cameraPoseToEnu(state.camera, origin);
  sample.basisColumns.forEach((axis, i) =>
    near(axis, expected.basisColumns[i]),
  );
});

test('long decimal timelines do not gain a rounding-only frame', () => {
  const p = project(
    Array.from({ length: 10000 }, (_, i) => ({
      id: `shot-${i}`,
      durationSec: 0.1,
      holdSec: 0,
      camera: pose(),
    })),
  );
  const m = adapter.exportCameraManifest(p, options());
  assert.equal(m.timeline.durationSec, 1000);
  assert.equal(m.frames.length, 30000);
  assert.equal(m.shots[9999].frameEndExclusive, 30001);
});

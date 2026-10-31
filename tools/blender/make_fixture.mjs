#!/usr/bin/env node
/** Generate tiny, provider-free fixtures plus an independent Cesium projection oracle. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as C from 'cesium';
import { exportCameraManifest } from '../../src/tooling/blenderCamera.js';
import { sceneSeekState } from '../../src/director/timeline.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output)
  throw new Error(
    'Usage: node tools/blender/make_fixture.mjs --output directory',
  );
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const pose = (values) => ({
  lat: 39.7003,
  lon: -105.0004,
  alt: 1750,
  heading: 20,
  pitch: -25,
  roll: 17,
  altitudeReference: 'ellipsoid',
  ...values,
});
const finish = pose({
  lat: 39.7005,
  lon: -104.9995,
  alt: 1800,
  heading: 95,
  pitch: -40,
  roll: -25,
});
const cut = pose({
  lat: 39.6998,
  lon: -105.0003,
  alt: 1725,
  heading: 230,
  pitch: -15,
  roll: 35,
});
const document = {
  version: 6,
  scenes: [
    {
      id: 'synthetic-scene',
      title: 'Synthetic camera bridge',
      shots: [
        {
          id: 'rolled-move',
          title: 'Move and hold',
          durationSec: 0.2,
          holdSec: 0.1,
          camera: finish,
          move: { from: pose({}), easing: 'cubic-in-out' },
        },
        {
          id: 'cut',
          title: 'Explicit cut and hold',
          durationSec: 0.2,
          holdSec: 0.1,
          camera: cut,
          move: { from: cut, easing: 'linear' },
        },
      ],
    },
  ],
};
const origin = { lat: 39.7, lon: -105, height: 1600 };
const anchor = C.Cartesian3.fromDegrees(origin.lon, origin.lat, origin.height);
const worldToLocal = C.Matrix4.inverseTransformation(
  C.Transforms.eastNorthUpToFixedFrame(anchor),
  new C.Matrix4(),
);
const cases = [];
for (const [name, width, height] of [
  ['landscape', 1920, 1080],
  ['portrait', 1080, 1920],
]) {
  const manifest = exportCameraManifest(document, {
    origin,
    fps: { numerator: 30000, denominator: 1001 },
    width,
    height,
    horizontalFovDegrees: 70,
  });
  await writeFile(
    resolve(output, `${name}.camera.json`),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  const camera = new C.Camera({
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new C.GeographicProjection(),
    mode: C.SceneMode.SCENE3D,
  });
  camera.frustum.aspectRatio = width / height;
  camera.frustum.fov =
    width >= height
      ? manifest.camera.horizontalFovRadians
      : manifest.camera.verticalFovRadians;
  camera.frustum.near = 0.01;
  camera.frustum.far = 200000;
  const checks = [];
  for (const sample of manifest.frames) {
    const state = sceneSeekState(
      document.scenes[0],
      sample.timeSec / manifest.timeline.durationSec,
      (_scene, shot) => shot.durationSec + shot.holdSec,
      (_scene, shot) => shot.holdSec,
    );
    const p = state.camera;
    camera.setView({
      destination: C.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
      orientation: {
        heading: C.Math.toRadians(p.heading),
        pitch: C.Math.toRadians(p.pitch),
        roll: C.Math.toRadians(p.roll),
      },
    });
    const projectionView = C.Matrix4.multiply(
      camera.frustum.projectionMatrix,
      camera.viewMatrix,
      new C.Matrix4(),
    );
    const points = [];
    for (const [right, up] of [
      [0, 0],
      [25, 0],
      [-25, 15],
      [0, -20],
    ]) {
      const world = C.Cartesian3.clone(camera.positionWC);
      for (const [axis, distance] of [
        [camera.directionWC, 100],
        [camera.rightWC, right],
        [camera.upWC, up],
      ]) {
        C.Cartesian3.add(
          world,
          C.Cartesian3.multiplyByScalar(axis, distance, new C.Cartesian3()),
          world,
        );
      }
      const clip = C.Matrix4.multiplyByVector(
        projectionView,
        new C.Cartesian4(world.x, world.y, world.z, 1),
        new C.Cartesian4(),
      );
      const local = C.Matrix4.multiplyByPoint(
        worldToLocal,
        world,
        new C.Cartesian3(),
      );
      points.push({
        position: [local.x, local.y, local.z],
        uv: [(clip.x / clip.w + 1) / 2, (clip.y / clip.w + 1) / 2],
      });
    }
    checks.push({ frame: sample.frame, shotId: sample.shotId, points });
  }
  cases.push({ name, manifest: `${name}.camera.json`, checks });
}
await writeFile(
  resolve(output, 'scene.json'),
  JSON.stringify(document, null, 2) + '\n',
);
await writeFile(
  resolve(output, 'projection-reference.json'),
  JSON.stringify({ origin, cases }, null, 2) + '\n',
);
console.log('CAMERA_FIXTURE_OK');

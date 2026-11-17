import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneTimingForShot,
  sceneSeekState,
  cameraAtProgress,
} from './timeline.js';
const camera = (lon, heading) => ({
  lat: 10,
  lon,
  alt: 1000,
  heading,
  pitch: -40,
  roll: 0,
});
const scene = {
  shots: [
    { id: 'a', durationSec: 2, holdSec: 1, camera: camera(20, 350) },
    { id: 'b', durationSec: 4, holdSec: 3, camera: camera(24, 10) },
  ],
};
const duration = (_, shot) => shot.durationSec + shot.holdSec;
const hold = (_, shot) => shot.holdSec;

test('scene time accounts for flight and hold; exact boundaries select the next shot', () => {
  const time = sceneTimingForShot(scene, scene.shots[1], duration);
  assert.equal(time.startElapsedSec, 3);
  assert.equal(time.endElapsedSec, 10);
  const seek = (progress) => sceneSeekState(scene, progress, duration, hold);
  assert.equal(seek(-1).shot.id, 'a');
  assert.equal(seek(0.3).shot.id, 'b');
  assert.equal(seek(0.3).cameraProgress, 0);
  assert.equal(seek(0.5).cameraProgress, 0.5);
  assert.equal(seek(0.5).camera.lon, 22);
  assert.equal(seek(0.8).holdElapsedSec, 1);
  assert.equal(seek(2).holdProgress, 1);
  assert.equal(seek(0).sceneElapsedSec, 0);
  assert.equal(sceneSeekState({ shots: [] }, 1, duration, hold), null);
});

test('camera seeking preserves cubic easing and shortest-angle orientation', () => {
  assert.equal(
    cameraAtProgress(camera(20, 350), camera(24, 10), 0.5).heading,
    360,
  );
  assert.equal(
    cameraAtProgress(camera(20, 350), camera(24, 10), 0.25).lon,
    20.25,
  );
  assert.deepEqual(cameraAtProgress(null, camera(20, 350), 0), camera(20, 350));
});

test('seeking to a shot start lands in that shot for every shot count and duration', () => {
  const misses = [];
  for (let count = 2; count <= 12; count += 1) {
    for (let flightTenths = 1; flightTenths <= 100; flightTenths += 1) {
      for (let holdTenths = 0; holdTenths <= 50; holdTenths += 1) {
        const shots = Array.from({ length: count }, (_, index) => ({
          id: `s${index}`,
          // Every third shot is longer, so boundaries are not all equal steps.
          durationSec: flightTenths / 10 + (index % 3 === 2 ? 1.7 : 0),
          holdSec: holdTenths / 10,
          camera: camera(20, 0),
        }));
        const mixed = { shots };
        for (const [index, shot] of shots.entries()) {
          const { startProgress, startElapsedSec } = sceneTimingForShot(
            mixed,
            shot,
            duration,
          );
          const seek = sceneSeekState(mixed, startProgress, duration, hold);
          // One or two ulps earlier still belongs to the previous shot.
          const before = startProgress * (1 - Number.EPSILON);
          const previous = sceneSeekState(mixed, before, duration, hold);
          if (
            seek.shotIndex !== index ||
            seek.sceneElapsedSec < startElapsedSec ||
            previous.shotIndex !== Math.max(0, index - 1)
          )
            misses.push(`${count}x${flightTenths}/${holdTenths}#${index}`);
        }
      }
    }
  }
  assert.deepEqual(misses.slice(0, 5), []);
});

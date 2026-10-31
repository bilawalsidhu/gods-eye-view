/** Camera-only interchange. No viewer, providers, environment files or terrain access. */
import * as C from 'cesium';
import { validateSceneDocument } from '../director/document.js';
import {
  resolveCameraPose,
  resolveCameraMove,
  sampleCameraMove,
} from '../director/camera.js';
import { cameraAtProgress } from '../director/timeline.js';

export const CAMERA_MANIFEST_SCHEMA = 'gev.camera-manifest.v1';
export const MAX_CAMERA_FRAMES = 100000;

function number(value, label, min, max) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new RangeError(
      `${label} must be a finite number in [${min}, ${max}]`,
    );
  }
  return value;
}

function position(pose, heightKey = 'alt') {
  if (!pose) throw new TypeError('A complete camera position is required');
  number(pose.lat, 'lat', -90, 90);
  number(pose.lon, 'lon', -180, 180);
  number(pose[heightKey], heightKey, -12000, 1e9);
}

/** Convert Cesium's WGS84/heading-pitch-roll pose to a fixed Blender ENU frame.
 * Angles are degrees; alt and origin.height are WGS84 ellipsoid meters.
 * The returned columns are Blender's local X (right), Y (up), Z (back).
 */
export function cameraPoseToEnu(pose, origin) {
  position(pose);
  position(origin, 'height');
  // Short-arc sampling can pass 360 degrees even when both saved endpoints do not.
  for (const key of ['heading', 'roll']) number(pose[key], key, -720, 720);
  number(pose.pitch, 'pitch', -90, 90);
  const xyz = C.Cartesian3.fromDegrees(
    pose.lon,
    pose.lat,
    pose.alt,
    C.Ellipsoid.WGS84,
  );
  const anchor = C.Cartesian3.fromDegrees(
    origin.lon,
    origin.lat,
    origin.height,
    C.Ellipsoid.WGS84,
  );
  if (C.Cartesian3.distance(xyz, anchor) > 100000)
    throw new RangeError('Camera exceeds the 100 km local-origin limit');
  const inverse = C.Matrix4.inverseTransformation(
    C.Transforms.eastNorthUpToFixedFrame(anchor),
    new C.Matrix4(),
  );
  const local = C.Matrix4.multiplyByPoint(inverse, xyz, new C.Cartesian3());
  // Same basis as Cesium Camera.setView3D, including its heading - PI/2 offset.
  // This is the coordinate math retained from the staged ENU camera prototype.
  const rotation = C.Matrix3.fromQuaternion(
    C.Quaternion.fromHeadingPitchRoll(
      new C.HeadingPitchRoll(
        C.Math.toRadians(pose.heading) - Math.PI / 2,
        C.Math.toRadians(pose.pitch),
        C.Math.toRadians(pose.roll),
      ),
    ),
  );
  const cameraFrame = C.Transforms.eastNorthUpToFixedFrame(xyz);
  const transform = (vector) =>
    C.Matrix4.multiplyByPointAsVector(
      inverse,
      C.Matrix4.multiplyByPointAsVector(
        cameraFrame,
        vector,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
  const forward = transform(
    C.Matrix3.getColumn(rotation, 0, new C.Cartesian3()),
  );
  const up = transform(C.Matrix3.getColumn(rotation, 2, new C.Cartesian3()));
  const right = C.Cartesian3.cross(forward, up, new C.Cartesian3());
  const array = (v) => [v.x, v.y, v.z];
  return {
    position: array(local),
    basisColumns: [
      array(right),
      array(up),
      array(C.Cartesian3.negate(forward, new C.Cartesian3())),
    ],
  };
}

function identity(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${label} requires a saved ID`);
  return value;
}

/** Export one existing scene using Director seek interpolation and authored timing.
 * Projection is explicit because scene documents do not store viewport lenses.
 * Frame 1 samples time zero; the final sample precedes the exclusive end time.
 */
export function exportCameraManifest(
  project,
  {
    sceneId,
    origin,
    fps,
    width,
    height,
    horizontalFovDegrees,
    sensorWidthMm = 36,
  } = {},
) {
  validateSceneDocument(project);
  position(origin, 'height');
  for (const key of ['numerator', 'denominator']) {
    number(fps?.[key], `fps.${key}`, 1, 1000000);
    if (!Number.isInteger(fps[key]))
      throw new RangeError('fps must be a positive integer ratio');
  }
  const rate = number(fps.numerator / fps.denominator, 'frame rate', 1, 240);
  for (const [key, value] of Object.entries({ width, height })) {
    number(value, key, 4, 16384);
    if (!Number.isInteger(value))
      throw new RangeError(`${key} must be an integer`);
  }
  number(horizontalFovDegrees, 'horizontal FOV degrees', 1, 179);
  number(sensorWidthMm, 'sensor width mm', 1, 100);
  const candidates = project.scenes.filter(
    (scene) => sceneId === undefined || scene.id === sceneId,
  );
  if (candidates.length !== 1)
    throw new Error('Select exactly one scene with sceneId');
  const scene = candidates[0];
  identity(scene.id, 'Scene');
  if (!scene.shots.length) throw new Error('Scene has no camera shots');
  const frameAt = (seconds) => {
    const frame = seconds * rate;
    return (
      (Math.abs(frame - Math.round(frame)) < 1e-9
        ? Math.round(frame)
        : Math.ceil(frame)) + 1
    );
  };
  let elapsed = 0;
  let rounding = 0;
  const shots = scene.shots.map((shot) => {
    identity(shot.id, 'Shot');
    const camera = resolveCameraPose(scene, shot.camera);
    position(camera);
    const move = resolveCameraMove(scene, shot);
    if (move) position(move.from);
    cameraPoseToEnu(camera, origin);
    if (move) cameraPoseToEnu(move.from, origin);
    const durationSec = shot.durationSec || 4;
    const holdSec = shot.holdSec || 0;
    const startTimeSec = elapsed;
    // Compensated summation prevents long decimal timelines gaining a frame.
    const increment = durationSec + holdSec - rounding;
    const next = elapsed + increment;
    rounding = next - elapsed - increment;
    elapsed = next;
    const frameStart = frameAt(startTimeSec);
    const frameEndExclusive = frameAt(elapsed);
    if (frameStart >= frameEndExclusive)
      throw new Error(`Shot ${shot.id} has no sampled frame at this fps`);
    return {
      id: shot.id,
      title: shot.title || '',
      ...(shot.sourcePackId
        ? {
            sourcePackId: shot.sourcePackId,
            sourcePackVersion: shot.sourcePackVersion ?? null,
          }
        : {}),
      startTimeSec,
      endTimeSec: elapsed,
      durationSec,
      holdSec,
      frameStart,
      frameEndExclusive,
      camera,
      move,
    };
  });
  const frameCount = frameAt(elapsed) - 1;
  if (frameCount > MAX_CAMERA_FRAMES)
    throw new RangeError(`Export exceeds ${MAX_CAMERA_FRAMES} camera frames`);
  const frames = [];
  let shotIndex = 0;
  for (let frame = 1; frame <= frameCount; frame += 1) {
    while (
      frame >= shots[shotIndex].frameEndExclusive &&
      shotIndex < shots.length - 1
    )
      shotIndex += 1;
    const shot = shots[shotIndex];
    const timeSec = ((frame - 1) * fps.denominator) / fps.numerator;
    const progress = Math.max(
      0,
      Math.min(
        1,
        (timeSec - shot.startTimeSec) / Math.max(0.001, shot.durationSec),
      ),
    );
    const pose = shot.move
      ? sampleCameraMove(shot.move, progress)
      : cameraAtProgress(
          shots[shotIndex - 1]?.camera || shot.camera,
          shot.camera,
          progress,
        );
    frames.push({
      frame,
      timeSec,
      shotId: shot.id,
      ...cameraPoseToEnu(pose, origin),
    });
  }
  const horizontalFovRadians = C.Math.toRadians(horizontalFovDegrees);
  const lensMm = number(
    sensorWidthMm / (2 * Math.tan(horizontalFovRadians / 2)),
    'Blender lens mm',
    1,
    10000,
  );
  return {
    schema: CAMERA_MANIFEST_SCHEMA,
    source: {
      sceneId: scene.id,
      sceneTitle: scene.title || '',
      documentVersion: project.version ?? 1,
      sampling: 'director-seek-authored-timing',
      attributions: (scene.dataPacks || []).map(({ attribution }) =>
        structuredClone(attribution),
      ),
    },
    coordinates: {
      units: 'meters',
      axes: 'east-north-up',
      heightDatum: 'WGS84-ellipsoid',
      origin: { ...origin },
      cameraAxes: 'X-right,Y-up,-Z-forward',
    },
    camera: {
      projection: 'perspective',
      sensorFit: 'HORIZONTAL',
      sensorWidthMm,
      lensMm,
      horizontalFovRadians,
      verticalFovRadians:
        2 * Math.atan((Math.tan(horizontalFovRadians / 2) * height) / width),
    },
    timeline: {
      fps: { ...fps },
      width,
      height,
      pixelAspect: [1, 1],
      frameStart: 1,
      frameEnd: frameCount,
      durationSec: elapsed,
    },
    shots,
    frames,
  };
}

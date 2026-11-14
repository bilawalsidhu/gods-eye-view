/** Camera-only USD interchange. No viewer, providers, environment files or terrain access. */
import * as C from 'cesium';
import { validateSceneDocument } from '../director/document.js';
import {
  resolveCameraPose,
  resolveCameraMove,
  sampleCameraMove,
} from '../director/camera.js';
import { cameraAtProgress } from '../director/timeline.js';
import {
  effectiveShotHoldSec,
  runtimeLayerStatesForShot,
  shotRuntimeDurationSec,
} from '../scenes/shotPresentation.js';
import { createDefaultScenePacks } from '../scenes/packs/defaults.js';

export const CAMERA_USD_SCHEMA = 'gev.camera-usd.v1';
export const MAX_CAMERA_FRAMES = 100000;
export const MAX_CAMERA_USDA_BYTES = 64 * 1024 * 1024;
// USD camera lens attributes are tenths of a scene unit. With metersPerUnit = 1
// one tenth is 100 mm; Blender's importer multiplies by 100 * metersPerUnit.
const MM_PER_USD_LENS_UNIT = 100;
const clamp01 = (value) => Math.max(0, Math.min(1, value));

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
 * The returned columns are the camera's local X (right), Y (up), Z (back),
 * which is the USD and Blender camera convention (looking down local -Z).
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

/** Resolve the flight-plus-hold seconds and holds that Director playback and seeking use.
 * Both come from shotPresentation.js, so registered pack overrides, minimum holds and
 * evidence-sequence durations match the app instead of the saved holdSec alone.
 */
export function sceneRuntimeTiming(
  scene,
  scenePacks = createDefaultScenePacks(),
) {
  const byShot = new Map();
  for (const shot of scene.shots) {
    const durationSec = shotRuntimeDurationSec(scene, shot, scenePacks);
    // Same states shotRuntimeDurationSec uses; omitting them would rebuild
    // every shot's timing per call (quadratic for long scenes).
    const holdSec = effectiveShotHoldSec(
      scene,
      shot,
      scenePacks,
      runtimeLayerStatesForShot(shot, scenePacks),
    );
    number(durationSec, `Shot ${shot.id} runtime duration`, 0, 1e7);
    number(holdSec, `Shot ${shot.id} runtime hold`, 0, 1e7);
    byShot.set(shot, { durationSec, holdSec });
  }
  return {
    durationFor: (_scene, shot) => byShot.get(shot).durationSec,
    holdFor: (_scene, shot) => byShot.get(shot).holdSec,
  };
}

/** Sample one saved scene with Director seek interpolation and runtime playback timing.
 * Projection is explicit because scene documents do not store viewport lenses.
 * Frame 1 samples time zero; the final sample precedes the exclusive end time.
 */
export function sampleSceneCameras(
  project,
  {
    sceneId,
    origin,
    fps,
    width,
    height,
    horizontalFovDegrees,
    sensorWidthMm = 36,
    scenePacks = createDefaultScenePacks(),
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
  const timing = sceneRuntimeTiming(scene, scenePacks);
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
  const resolved = scene.shots.map((shot, index) => ({
    target: resolveCameraPose(scene, shot.camera),
    previous: resolveCameraPose(
      scene,
      scene.shots[index - 1]?.camera || shot.camera,
    ),
    move: resolveCameraMove(scene, shot),
  }));
  const shots = scene.shots.map((shot) => {
    identity(shot.id, 'Shot');
    const camera = resolveCameraPose(scene, shot.camera);
    position(camera);
    const move = resolveCameraMove(scene, shot);
    if (move) position(move.from);
    cameraPoseToEnu(camera, origin);
    if (move) cameraPoseToEnu(move.from, origin);
    const runtimeDurationSec = timing.durationFor(scene, shot);
    const startTimeSec = elapsed;
    // Compensated summation prevents long decimal timelines gaining a frame.
    const increment = runtimeDurationSec - rounding;
    const next = elapsed + increment;
    rounding = next - elapsed - increment;
    elapsed = next;
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
      flightDurationSec: shot.durationSec || 4,
      authoredHoldSec: Number(shot.holdSec) || 0,
      runtimeHoldSec: timing.holdFor(scene, shot),
      frameStart: 0,
      frameEndExclusive: 0,
    };
  });
  const frameCount = frameAt(elapsed) - 1;
  if (frameCount > MAX_CAMERA_FRAMES)
    throw new RangeError(`Export exceeds ${MAX_CAMERA_FRAMES} camera frames`);
  if (frameCount < 1) throw new Error('Scene has no sampled frame at this fps');
  // Mirror sceneSeekState (src/director/timeline.js) step for step, walking
  // shots forward once instead of rescanning every shot for every frame.
  // Tests compare each sample with sceneSeekState itself.
  const seekEnds = [];
  for (const shot of scene.shots)
    seekEnds.push((seekEnds.at(-1) || 0) + timing.durationFor(scene, shot));
  const seekTotalSec = seekEnds.at(-1);
  const frames = [];
  let shotIndex = 0;
  for (let frame = 1; frame <= frameCount; frame += 1) {
    const timeSec = ((frame - 1) * fps.denominator) / fps.numerator;
    const normalized = clamp01(timeSec / seekTotalSec);
    while (
      shotIndex < shots.length - 1 &&
      !(normalized < seekEnds[shotIndex] / seekTotalSec)
    )
      shotIndex += 1;
    const source = scene.shots[shotIndex];
    const startElapsedSec = shotIndex ? seekEnds[shotIndex - 1] : 0;
    const elapsedSec = Math.max(normalized * seekTotalSec, startElapsedSec);
    const flightDurationSec = source.durationSec || 4;
    const shotDurationSec = Math.max(
      0.001,
      flightDurationSec + timing.holdFor(scene, source),
    );
    const shotElapsedSec = Math.max(
      0,
      Math.min(shotDurationSec, elapsedSec - startElapsedSec),
    );
    const cameraProgress = clamp01(
      shotElapsedSec / Math.max(0.001, flightDurationSec),
    );
    const { target, previous, move } = resolved[shotIndex];
    const pose = move
      ? sampleCameraMove(move, cameraProgress)
      : cameraAtProgress(previous, target, cameraProgress);
    const shot = shots[shotIndex];
    if (!shot.frameStart) shot.frameStart = frame;
    shot.frameEndExclusive = frame + 1;
    frames.push({
      frame,
      timeSec,
      shotId: shot.id,
      ...cameraPoseToEnu(pose, origin),
    });
  }
  for (const shot of shots) {
    if (!shot.frameStart)
      throw new Error(`Shot ${shot.id} has no sampled frame at this fps`);
  }
  const horizontalFovRadians = C.Math.toRadians(horizontalFovDegrees);
  const lensMm = number(
    sensorWidthMm / (2 * Math.tan(horizontalFovRadians / 2)),
    'Blender lens mm',
    1,
    10000,
  );
  return {
    schema: CAMERA_USD_SCHEMA,
    source: {
      sceneId: scene.id,
      sceneTitle: scene.title || '',
      documentVersion: project.version ?? 1,
      sampling: 'director-seek-runtime-timing',
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
      sensorWidthMm,
      sensorHeightMm: (sensorWidthMm * height) / width,
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

/** Shortest decimal for a finite double, without signed zero or 17-digit noise. */
function usdNumber(value) {
  const rounded = Number(value.toPrecision(15));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Quote text for a .usda string literal. */
function usdString(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
      (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
    )}"`;
}

/** USD prim names are identifiers; saved IDs stay in custom properties. */
function shotPrimName(shot, index) {
  const safe = shot.id.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
  return `Shot_${String(index + 1).padStart(3, '0')}_${safe}`;
}

/** USD matrices are row-vector: rows are camera X, Y, Z axes, then translation. */
function usdMatrix({ position: p, basisColumns: [right, up, back] }) {
  const row = (values, w) => `(${[...values, w].map(usdNumber).join(', ')})`;
  return `( ${row(right, 0)}, ${row(up, 0)}, ${row(back, 0)}, ${row(p, 1)} )`;
}

/** Write sampled cameras as a plain-text USD stage that Blender imports natively.
 * Z-up meters, one perspective camera per shot, time codes equal to frame numbers.
 */
export function cameraSamplesToUsda(samples) {
  const { source, coordinates, camera, timeline, shots, frames } = samples;
  const rate = timeline.fps.numerator / timeline.fps.denominator;
  const shotTable = shots.map(
    ({
      id,
      title,
      sourcePackId,
      sourcePackVersion,
      startTimeSec,
      endTimeSec,
      flightDurationSec,
      authoredHoldSec,
      runtimeHoldSec,
      frameStart,
      frameEndExclusive,
    }) => ({
      id,
      title,
      ...(sourcePackId ? { sourcePackId, sourcePackVersion } : {}),
      startTimeSec,
      endTimeSec,
      flightDurationSec,
      authoredHoldSec,
      runtimeHoldSec,
      frameStart,
      frameEndExclusive,
    }),
  );
  const json = (value) => usdString(JSON.stringify(value));
  const out = [
    '#usda 1.0',
    '(',
    '    customLayerData = {',
    `        string gevCamera = ${json(camera)}`,
    `        string gevCoordinates = ${json(coordinates)}`,
    `        string gevSchema = ${usdString(CAMERA_USD_SCHEMA)}`,
    `        string gevShots = ${json(shotTable)}`,
    `        string gevSource = ${json(source)}`,
    `        string gevTimeline = ${json(timeline)}`,
    '    }',
    '    defaultPrim = "GEV"',
    `    doc = ${usdString("God's Eye View Director cameras: ENU meters around a WGS84 ellipsoid origin; time codes are frame numbers.")}`,
    `    endTimeCode = ${timeline.frameEnd}`,
    `    framesPerSecond = ${rate}`,
    '    metersPerUnit = 1',
    `    startTimeCode = ${timeline.frameStart}`,
    `    timeCodesPerSecond = ${rate}`,
    '    upAxis = "Z"',
    ')',
    '',
    'def Xform "GEV"',
    '{',
    `    custom string userProperties:gevSchema = ${usdString(CAMERA_USD_SCHEMA)}`,
    `    custom string userProperties:gevSceneId = ${usdString(source.sceneId)}`,
    `    custom string userProperties:gevSceneTitle = ${usdString(source.sceneTitle)}`,
    `    custom string userProperties:gevOrigin = ${json(coordinates.origin)}`,
    `    custom string userProperties:gevFps = ${usdString(`${timeline.fps.numerator}/${timeline.fps.denominator}`)}`,
    `    custom int userProperties:gevWidth = ${timeline.width}`,
    `    custom int userProperties:gevHeight = ${timeline.height}`,
    `    custom string userProperties:gevAttributions = ${json(source.attributions)}`,
  ];
  shots.forEach((shot, index) => {
    out.push(
      '',
      `    def Camera ${usdString(shotPrimName(shot, index))}`,
      '    {',
      '        float2 clippingRange = (0.01, 200000)',
      `        float focalLength = ${usdNumber(camera.lensMm / MM_PER_USD_LENS_UNIT)}`,
      `        float horizontalAperture = ${usdNumber(camera.sensorWidthMm / MM_PER_USD_LENS_UNIT)}`,
      `        float verticalAperture = ${usdNumber(camera.sensorHeightMm / MM_PER_USD_LENS_UNIT)}`,
      '        token projection = "perspective"',
      `        custom string userProperties:gevShotId = ${usdString(shot.id)}`,
      `        custom string userProperties:gevShotTitle = ${usdString(shot.title)}`,
      ...(shot.sourcePackId
        ? [
            `        custom string userProperties:gevSourcePackId = ${usdString(shot.sourcePackId)}`,
            `        custom string userProperties:gevSourcePackVersion = ${usdString(shot.sourcePackVersion ?? '')}`,
          ]
        : []),
      `        custom int userProperties:gevFrameStart = ${shot.frameStart}`,
      `        custom int userProperties:gevFrameEndExclusive = ${shot.frameEndExclusive}`,
      `        custom double userProperties:gevStartTimeSec = ${usdNumber(shot.startTimeSec)}`,
      `        custom double userProperties:gevEndTimeSec = ${usdNumber(shot.endTimeSec)}`,
      `        custom double userProperties:gevFlightDurationSec = ${usdNumber(shot.flightDurationSec)}`,
      `        custom double userProperties:gevAuthoredHoldSec = ${usdNumber(shot.authoredHoldSec)}`,
      `        custom double userProperties:gevRuntimeHoldSec = ${usdNumber(shot.runtimeHoldSec)}`,
      '        matrix4d xformOp:transform.timeSamples = {',
    );
    for (let f = shot.frameStart; f < shot.frameEndExclusive; f += 1) {
      out.push(`            ${f}: ${usdMatrix(frames[f - 1])},`);
    }
    out.push(
      '        }',
      '        uniform token[] xformOpOrder = ["xformOp:transform"]',
      '    }',
    );
  });
  out.push('}', '');
  return out.join('\n');
}

/** Export one saved scene as a .usda camera stage. */
export function exportCameraUsda(project, options) {
  const samples = sampleSceneCameras(project, options);
  const usda = cameraSamplesToUsda(samples);
  if (Buffer.byteLength(usda) > MAX_CAMERA_USDA_BYTES)
    throw new RangeError('Camera USD exceeds 64 MiB');
  return { usda, samples };
}

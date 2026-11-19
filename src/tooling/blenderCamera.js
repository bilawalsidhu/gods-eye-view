/** Camera-only USD interchange. No viewer, providers, environment files or terrain access. */
import * as C from 'cesium';
import { validateSceneDocument } from '../director/document.js';
import { resolveCameraPose } from '../director/camera.js';
import { sceneSeekState } from '../director/timeline.js';
import { headingPitchRollFrame } from '../geo/quaternion.js';
import { normalizeProject } from '../scenes/project.js';
import { shotRuntimeTiming } from '../scenes/shotPresentation.js';
import { createDefaultScenePacks } from '../scenes/packs/defaults.js';

export const CAMERA_USD_SCHEMA = 'gev.camera-usd.v1';
export const MAX_CAMERA_FRAMES = 100000;
export const MAX_CAMERA_USDA_BYTES = 64 * 1024 * 1024;
// USD camera lens attributes are tenths of a scene unit. With metersPerUnit = 1
// one tenth is 100 mm; Blender's importer multiplies by 100 * metersPerUnit.
const MM_PER_USD_LENS_UNIT = 100;

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

function integer(value, label, min, max) {
  if (!Number.isInteger(number(value, label, min, max)))
    throw new RangeError(`${label} must be an integer`);
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
export function cameraPoseToEnu(pose, origin, label = 'Camera') {
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
  const distance = C.Cartesian3.distance(xyz, anchor);
  if (distance > 100000)
    throw new RangeError(
      `${label} is ${(distance / 1000).toFixed(1)} km from the origin (limit 100 km)`,
    );
  // Geodetic ENU (as in PROJ): axes from the ellipsoid normal at the origin's
  // lat/lon, origin raised along it. Cesium's frame at a raised point tilts.
  const frame = C.Transforms.eastNorthUpToFixedFrame(
    C.Cartesian3.fromDegrees(origin.lon, origin.lat, 0, C.Ellipsoid.WGS84),
  );
  const inverse = C.Matrix4.inverseTransformation(
    C.Matrix4.setTranslation(frame, anchor, frame),
    new C.Matrix4(),
  );
  const local = C.Matrix4.multiplyByPoint(inverse, xyz, new C.Cartesian3());
  // Same basis as Cesium Camera.setView3D, including its heading - PI/2 offset.
  const body = headingPitchRollFrame(xyz, {
    heading: C.Math.toRadians(pose.heading) - Math.PI / 2,
    pitch: C.Math.toRadians(pose.pitch),
    roll: C.Math.toRadians(pose.roll),
  });
  const toLocal = (axis) =>
    C.Matrix4.multiplyByPointAsVector(inverse, axis, new C.Cartesian3());
  const forward = toLocal(body.x);
  const up = toLocal(body.z);
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

/** Resolve each shot's runtime seconds and hold once, as Director seeking does. */
export function sceneRuntimeTiming(
  scene,
  scenePacks = createDefaultScenePacks(),
) {
  const byShot = new Map();
  for (const shot of scene.shots) {
    const timing = shotRuntimeTiming(scene, shot, scenePacks);
    number(timing.durationSec, `Shot ${shot.id} runtime duration`, 0, 1e7);
    number(timing.holdSec, `Shot ${shot.id} runtime hold`, 0, 1e7);
    byShot.set(shot, timing);
  }
  return {
    durationFor: (_scene, shot) => byShot.get(shot).durationSec,
    holdFor: (_scene, shot) => byShot.get(shot).holdSec,
  };
}

/** Sample one saved scene with Director seek interpolation and runtime seek timing.
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
  for (const key of ['numerator', 'denominator'])
    integer(fps?.[key], `fps.${key}`, 1, 1000000);
  const rate = number(fps.numerator / fps.denominator, 'frame rate', 1, 240);
  integer(width, 'width', 4, 16384);
  integer(height, 'height', 4, 16384);
  number(horizontalFovDegrees, 'horizontal FOV degrees', 1, 179);
  number(sensorWidthMm, 'sensor width mm', 1, 100);
  const candidates = project.scenes.filter(
    (scene) => sceneId === undefined || scene.id === sceneId,
  );
  if (candidates.length !== 1) {
    const ids = project.scenes
      .slice(0, 10)
      .map(({ id }) => id)
      .join(', ');
    throw new Error(
      sceneId === undefined
        ? `Choose one scene with --scene: ${ids}`
        : `No scene has ID ${sceneId}; scenes: ${ids}`,
    );
  }
  const saved = candidates[0];
  identity(saved.id, 'Scene');
  if (!saved.shots.length) throw new Error('Scene has no camera shots');
  for (const shot of saved.shots) {
    identity(shot.id, 'Shot');
    const pose = resolveCameraPose(saved, shot.camera);
    if (!pose || [pose.lat, pose.lon, pose.alt].includes(undefined))
      throw new TypeError(
        `Shot ${shot.id} requires a saved position; save the scene again in GEV`,
      );
  }
  // Director seeks the normalized project: legacy numeric text becomes
  // numbers and ordinary shots fly for at least 0.2 s.
  const scene = normalizeProject({ version: project.version, scenes: [saved] })
    .scenes[0];
  const timing = sceneRuntimeTiming(scene, scenePacks);
  let elapsed = 0;
  const shots = scene.shots.map((shot) => {
    const label = `Shot ${shot.id}`;
    cameraPoseToEnu(resolveCameraPose(scene, shot.camera), origin, label);
    if (shot.move)
      cameraPoseToEnu(resolveCameraPose(scene, shot.move.from), origin, label);
    // Running sums in sceneSeekState's order, so published seconds agree
    // with the frame each shot owns.
    const startTimeSec = elapsed;
    elapsed += timing.durationFor(scene, shot);
    return {
      id: shot.id,
      title: shot.title,
      ...(shot.sourcePackId
        ? {
            sourcePackId: shot.sourcePackId,
            sourcePackVersion: shot.sourcePackVersion ?? null,
          }
        : {}),
      startTimeSec,
      endTimeSec: elapsed,
      flightDurationSec: shot.durationSec,
      authoredHoldSec: shot.holdSec,
      runtimeHoldSec: timing.holdFor(scene, shot),
      frameStart: 0,
      frameEndExclusive: 0,
    };
  });
  // Ceiling of duration times fps. The tolerance bounds the rounding error of
  // decimal flight and hold seconds and their sums, so only that noise at a
  // frame boundary is dropped, never a real fraction of a frame.
  const exactFrames = elapsed * rate;
  const frameCount =
    Math.abs(exactFrames - Math.round(exactFrames)) <
    Number.EPSILON * (2 * shots.length + 1) * exactFrames
      ? Math.round(exactFrames)
      : Math.ceil(exactFrames);
  if (frameCount > MAX_CAMERA_FRAMES)
    throw new RangeError(`Export exceeds ${MAX_CAMERA_FRAMES} camera frames`);
  if (frameCount < 1) throw new Error('Scene has no sampled frame at this fps');
  const frames = [];
  for (let frame = 1; frame <= frameCount; frame += 1) {
    const timeSec = ((frame - 1) * fps.denominator) / fps.numerator;
    const state = sceneSeekState(
      scene,
      timeSec / elapsed,
      timing.durationFor,
      timing.holdFor,
    );
    const shot = shots[state.shotIndex];
    if (!shot.frameStart) shot.frameStart = frame;
    shot.frameEndExclusive = frame + 1;
    frames.push({
      frame,
      timeSec,
      shotId: shot.id,
      ...cameraPoseToEnu(state.camera, origin, `Shot ${shot.id}`),
    });
  }
  for (const shot of shots) {
    if (!shot.frameStart)
      throw new Error(`Shot ${shot.id} has no sampled frame at this fps`);
  }
  const lensMm = number(
    sensorWidthMm / (2 * Math.tan(C.Math.toRadians(horizontalFovDegrees) / 2)),
    'Blender lens mm',
    1,
    10000,
  );
  return {
    source: {
      sceneId: scene.id,
      sceneTitle: saved.title || '',
      attributions: (scene.dataPacks || []).map(({ attribution }) =>
        structuredClone(attribution),
      ),
    },
    coordinates: {
      origin: { lat: origin.lat, lon: origin.lon, height: origin.height },
    },
    camera: {
      sensorWidthMm,
      sensorHeightMm: (sensorWidthMm * height) / width,
      lensMm,
    },
    timeline: {
      fps: { numerator: fps.numerator, denominator: fps.denominator },
      width,
      height,
      frameStart: 1,
      frameEnd: frameCount,
      durationSec: elapsed,
    },
    shots,
    frames,
  };
}

/** Round a finite double to 15 significant digits and normalize signed zero. */
function usdNumber(value) {
  const rounded = Number(value.toPrecision(15));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

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
  integer(timeline.width, 'width', 4, 16384);
  integer(timeline.height, 'height', 4, 16384);
  integer(timeline.frameStart, 'frameStart', 1, MAX_CAMERA_FRAMES);
  integer(timeline.frameEnd, 'frameEnd', 1, MAX_CAMERA_FRAMES);
  for (const shot of shots) {
    integer(shot.frameStart, 'frameStart', 1, MAX_CAMERA_FRAMES);
    integer(
      shot.frameEndExclusive,
      'frameEndExclusive',
      2,
      MAX_CAMERA_FRAMES + 1,
    );
  }
  const rate = timeline.fps.numerator / timeline.fps.denominator;
  const json = (value) => usdString(JSON.stringify(value));
  const out = [
    '#usda 1.0',
    '(',
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
      `        custom double userProperties:gevStartTimeSec = ${number(shot.startTimeSec, 'startTimeSec', 0, Infinity)}`,
      `        custom double userProperties:gevEndTimeSec = ${number(shot.endTimeSec, 'endTimeSec', 0, Infinity)}`,
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

export function exportCameraUsda(project, options) {
  const samples = sampleSceneCameras(project, options);
  const usda = cameraSamplesToUsda(samples);
  if (Buffer.byteLength(usda) > MAX_CAMERA_USDA_BYTES)
    throw new RangeError('Camera USD exceeds 64 MiB');
  return { usda, samples };
}

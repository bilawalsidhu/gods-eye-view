const DEFAULT_SHOT_DURATION_SEC = 4;
const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Calculate one shot's boundaries using the supplied content duration resolver. */
export function sceneTimingForShot(scene, shot, durationForShot) {
  const durations =
    scene?.shots?.map((item) => durationForShot(scene, item)) || [];
  const shotIndex = scene?.shots?.findIndex(({ id }) => id === shot?.id) ?? -1;
  const totalSec = durations.reduce((sum, duration) => sum + duration, 0);
  const startElapsedSec = durations
    .slice(0, Math.max(0, shotIndex))
    .reduce((sum, duration) => sum + duration, 0);
  const durationSec = shotIndex >= 0 ? durations[shotIndex] : 0;
  const endElapsedSec = Math.min(totalSec, startElapsedSec + durationSec);
  return {
    shotIndex,
    totalSec,
    durationSec,
    startElapsedSec,
    endElapsedSec,
    startProgress: totalSec > 0 ? startElapsedSec / totalSec : 0,
    endProgress: totalSec > 0 ? endElapsedSec / totalSec : 1,
    durationProgress: totalSec > 0 ? durationSec / totalSec : 0,
  };
}

/** Interpolate the existing cubic camera pose, including shortest-angle orientation. */
export function cameraAtProgress(fromCamera, toCamera, progress) {
  const target = toCamera || fromCamera;
  const source = fromCamera || target;
  if (!source || !target) return target || source || null;
  const t = clamp01(Number(progress) || 0);
  const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
  const lerp = (from, to) => Number(from) + (Number(to) - Number(from)) * eased;
  const lerpAngle = (from, to) => {
    const start = Number(from) || 0;
    const delta = ((Number(to) - start + 540) % 360) - 180;
    return start + delta * eased;
  };
  return {
    lat: lerp(source.lat, target.lat),
    lon: lerp(source.lon, target.lon),
    alt: lerp(source.alt, target.alt),
    heading: lerpAngle(source.heading, target.heading),
    pitch: lerp(source.pitch, target.pitch),
    roll: lerpAngle(source.roll, target.roll),
  };
}

/** Resolve a normalized scene time to a shot, flight/hold phase and camera pose. */
export function sceneSeekState(scene, progress, durationForShot, holdForShot) {
  if (!scene?.shots?.length) return null;
  const normalized = clamp01(Number(progress) || 0);
  const durations = scene.shots.map((shot) => durationForShot(scene, shot));
  const totalSec = durations.reduce((sum, duration) => sum + duration, 0);
  const targetSec = normalized * Math.max(0, totalSec);
  let startElapsedSec = 0;
  let shotIndex = scene.shots.length - 1;
  for (let index = 0; index < scene.shots.length; index += 1) {
    const endElapsedSec = startElapsedSec + durations[index];
    if (targetSec < endElapsedSec || index === scene.shots.length - 1) {
      shotIndex = index;
      break;
    }
    startElapsedSec = endElapsedSec;
  }
  const shot = scene.shots[shotIndex];
  const flightDurationSec = shot.durationSec || DEFAULT_SHOT_DURATION_SEC;
  const holdDurationSec = holdForShot(scene, shot);
  const shotDurationSec = Math.max(0.001, flightDurationSec + holdDurationSec);
  const shotElapsedSec = Math.max(
    0,
    Math.min(shotDurationSec, targetSec - startElapsedSec),
  );
  const cameraProgress = clamp01(
    shotElapsedSec / Math.max(0.001, flightDurationSec),
  );
  const holdElapsedSec = Math.max(0, shotElapsedSec - flightDurationSec);
  const holdProgress =
    holdDurationSec > 0 ? clamp01(holdElapsedSec / holdDurationSec) : 1;
  const previousCamera = scene.shots[shotIndex - 1]?.camera || shot.camera;
  return {
    sceneProgress: totalSec > 0 ? targetSec / totalSec : 0,
    sceneElapsedSec: targetSec,
    sceneDurationSec: totalSec,
    shotIndex,
    shot,
    shotElapsedSec,
    shotProgress: clamp01(shotElapsedSec / shotDurationSec),
    flightDurationSec,
    holdDurationSec,
    holdElapsedSec,
    cameraProgress,
    holdProgress,
    camera: cameraAtProgress(previousCamera, shot.camera, cameraProgress),
  };
}

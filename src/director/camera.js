/** Portable camera poses and authored motion. Angles are degrees; heights are ellipsoidal meters. */

/** Resolve an inline pose or a scene-local geographic anchor without modifying authored state. */
export function resolveCameraPose(scene, camera) {
  if (!camera) return null;
  const position = camera.anchorId
    ? scene?.anchors?.find(({ id }) => id === camera.anchorId)
    : camera;
  if (!position) throw new Error('Camera anchor is unavailable');
  return {
    lat: position.lat,
    lon: position.lon,
    alt: position.alt,
    heading: camera.heading ?? 0,
    pitch: camera.pitch ?? -35,
    roll: camera.roll ?? 0,
  };
}

/** Resolve both authored endpoints. An explicit move never depends on the live viewport. */
export function resolveCameraMove(scene, shot) {
  if (!shot?.move) return null;
  return {
    from: resolveCameraPose(scene, shot.move.from),
    to: resolveCameraPose(scene, shot.camera),
    easing: shot.move.easing,
    durationSec: shot.durationSec,
  };
}

/** Sample the same authored curve for playback and seeking, taking the short longitude/angle arc. */
export function sampleCameraMove(move, progress) {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  if (t === 0) return { ...move.from };
  if (t === 1) return { ...move.to };
  const eased =
    move.easing === 'linear'
      ? t
      : t < 0.5
        ? 4 * t ** 3
        : 1 - (-2 * t + 2) ** 3 / 2;
  const lerp = (a, b) => a + (b - a) * eased;
  const angle = (a, b) =>
    a + (((((b - a + 540) % 360) + 360) % 360) - 180) * eased;
  const { from, to } = move;
  return {
    lat: lerp(from.lat, to.lat),
    lon: ((((angle(from.lon, to.lon) + 180) % 360) + 360) % 360) - 180,
    alt: lerp(from.alt, to.alt),
    heading: angle(from.heading, to.heading),
    pitch: lerp(from.pitch, to.pitch),
    roll: angle(from.roll, to.roll),
  };
}

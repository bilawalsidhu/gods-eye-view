/**
 * @module render/camera/poseSignature
 * @description A cheap "did the camera move" key for gating passes that
 * depend on the view: the eye's ECEF position to 10 m and its heading, pitch
 * and roll (radians) to a milliradian. It takes a camera port pose or any
 * `{position, heading, pitch, roll}`, so a renderer's own camera reads the
 * same key.
 */

/**
 * @param {{position: {x: number, y: number, z: number}, heading: number,
 *   pitch: number, roll: number}} pose
 * @returns {string}
 */
export function poseSignature(pose) {
  const p = pose.position;
  return (
    `${Math.round(p.x / 10)}:${Math.round(p.y / 10)}:${Math.round(p.z / 10)}:` +
    `${pose.heading.toFixed(3)}:${pose.pitch.toFixed(3)}:${pose.roll.toFixed(3)}`
  );
}

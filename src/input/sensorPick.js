/**
 * @module sensorPick
 * @description Where a click lands in the pick buffer while a sensor style
 * distorts the picture. Picks read the scene before post-processing, so under
 * the thermal or surveillance shader the pixel the user clicked shows a
 * different spot of the scene: map it back through the shader's barrel
 * distortion and quantization first.
 */
import * as Cesium from 'cesium';

const SENSOR_STYLES = ['thermal', 'surveillance'];

/**
 * The pick-buffer position for a screen click.
 * @param {Cesium.Scene} scene
 * @param {{x: number, y: number}} position CSS pixels on the canvas.
 * @returns {Cesium.Cartesian2} A new position; the click's own is left alone.
 */
export function sensorPickPosition(scene, position) {
  const out = new Cesium.Cartesian2(position.x, position.y);
  const stages = scene.postProcessStages;
  if (typeof stages?.getStageByName !== 'function') return out;
  for (const style of SENSOR_STYLES) {
    const stage = stages.getStageByName(`godsEyeView_${style}`);
    if (!stage?.enabled) continue;
    const intensity = stage.uniforms.intensity;
    const canvas = scene.canvas,
      w = canvas.clientWidth,
      h = canvas.clientHeight;
    let u = out.x / w,
      v = 1 - out.y / h;
    if (style === 'surveillance') {
      const x = u * 2 - 1,
        y = v * 2 - 1,
        r2 = x * x + y * y;
      const d = 1 + r2 * intensity * 0.25 + r2 * r2 * intensity * 0.075;
      u = (x * d + 1) / 2;
      v = (y * d + 1) / 2;
    }
    const grid = 1 + (stage.uniforms.pixelation - 1) * intensity;
    u +=
      ((Math.floor((u * canvas.width) / grid) * grid) / canvas.width - u) *
      intensity;
    v +=
      ((Math.floor((v * canvas.height) / grid) * grid) / canvas.height - v) *
      intensity;
    out.x = u * w;
    out.y = (1 - v) * h;
    return out;
  }
  return out;
}

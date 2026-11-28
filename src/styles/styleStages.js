/**
 * @module styles/styleStages
 * @description The app's record of each visual style on a scene object (the
 * viewer the application's visual effects are made for): its
 * intensity, parameter values and whether it draws, as the application set
 * them. Code that must follow a style's picture (sensor picks) reads it here
 * rather than asking the renderer.
 */

const records = new WeakMap();

/**
 * @param {object} scene The scene object.
 * @param {Record<string, {enabled: boolean, uniforms: Record<string, number>}>} stages
 * @returns {() => void} Forgets them, if they are still the scene's.
 */
export function registerStyleStages(scene, stages) {
  if (!scene || typeof scene !== 'object') return () => {};
  records.set(scene, stages);
  return () => {
    if (records.get(scene) === stages) records.delete(scene);
  };
}

/**
 * @param {object} scene
 * @returns {Record<string, {enabled: boolean, uniforms: Record<string, number>}> | null}
 */
export function styleStagesOf(scene) {
  if (!scene || typeof scene !== 'object') return null;
  return records.get(scene) ?? null;
}

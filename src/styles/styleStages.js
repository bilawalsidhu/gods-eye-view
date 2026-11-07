/**
 * @module styles/styleStages
 * @description Core's record of each visual style on a scene: its
 * intensity, parameter values and whether it draws, as the application set
 * them. Code that must follow a style's picture (sensor picks) reads it here
 * rather than asking the renderer.
 */

const records = new WeakMap();

/**
 * @param {object} scene
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
export const styleStagesOf = (scene) =>
  (scene && typeof scene === 'object' && records.get(scene)) || null;

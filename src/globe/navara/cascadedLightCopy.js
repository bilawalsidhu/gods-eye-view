// Navara 0.2.1 leak fix: Navara's transparent pass keeps a
// copy of each scene light and refreshes it every frame with
// `copy.copy(light, true)`. For the sun's cascaded shadow lights
// (@navaramap/three-csm CascadedDirectionalLights) that copy clones every
// cascade, so each frame brings new DirectionalLight objects with new ids,
// and three's WebGLLights uniforms cache (keyed by light id) grows by about
// 1.2 KB a frame in looks with a shadowed sun. The patched copy updates the
// cascades it already has in place (pose, colour, intensity, target, shadow
// settings and camera) when the cascade counts match, and keeps the original
// rebuild otherwise. internals.js applies it to the class Navara uses.
// Upstream ask: copy cascaded lights in place (or sync without copy()).

const PATCHED = Symbol('gev.cascadedLightCopy');

function copyLightInPlace(target, source) {
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.scale.copy(source.scale);
  target.matrix.copy(source.matrix);
  target.matrixWorld.copy(source.matrixWorld);
  target.matrixAutoUpdate = source.matrixAutoUpdate;
  target.visible = source.visible;
  target.castShadow = source.castShadow;
  target.layers.mask = source.layers.mask;
  target.color.copy(source.color);
  target.intensity = source.intensity;
  const to = target.target;
  const from = source.target;
  to.position.copy(from.position);
  to.quaternion.copy(from.quaternion);
  to.matrix.copy(from.matrix);
  to.matrixWorld.copy(from.matrixWorld);
  const shadow = target.shadow;
  const original = source.shadow;
  shadow.intensity = original.intensity;
  shadow.bias = original.bias;
  shadow.normalBias = original.normalBias;
  shadow.radius = original.radius;
  shadow.blurSamples = original.blurSamples;
  shadow.mapSize.copy(original.mapSize);
  shadow.camera.copy(original.camera);
  shadow.camera.updateProjectionMatrix?.();
}

/**
 * Patches CascadedDirectionalLights.prototype.copy (idempotent).
 * @returns {() => void} restore the original copy
 */
export function patchCascadedLightCopy(proto) {
  if (proto.copy[PATCHED]) return proto.copy[PATCHED];
  const original = proto.copy;
  if (typeof original !== 'function')
    throw new Error('CascadedDirectionalLights.copy not found');
  function copyInPlace(source, recursive) {
    const mine = this.cascadedLights;
    const theirs = source?.cascadedLights;
    if (
      !Array.isArray(mine) ||
      !Array.isArray(theirs) ||
      mine.length === 0 ||
      mine.length !== theirs.length
    )
      return original.call(this, source, recursive);
    // Object3D's own fields, without children (as the original's
    // super.copy(source, false)).
    this.name = source.name;
    this.position.copy(source.position);
    this.quaternion.copy(source.quaternion);
    this.scale.copy(source.scale);
    this.matrix.copy(source.matrix);
    this.matrixWorld.copy(source.matrixWorld);
    this.visible = source.visible;
    this.direction?.copy?.(source.direction);
    for (let index = 0; index < mine.length; index++)
      copyLightInPlace(mine[index], theirs[index]);
    return this;
  }
  copyInPlace.gevInPlace = true;
  const restore = () => {
    if (proto.copy === copyInPlace) proto.copy = original;
  };
  copyInPlace[PATCHED] = restore;
  proto.copy = copyInPlace;
  return restore;
}

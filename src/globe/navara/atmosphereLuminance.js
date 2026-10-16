// The cinematic look's brighter atmosphere (viewOptions.js
// ATMOSPHERE_LUMINANCE_SCALE): the radiance-to-luminance factors of the
// atmosphere's materials (sky, aerial perspective, clouds), multiplied by a
// scale. Navara 0.2.1 has no public setting for them; they are uniforms of
// the takram materials its descriptors build, reached through each handle's
// public `ref.raw`, then fields of those objects that are not documented:
//
// - sky: ref.raw (the three Mesh) .material.uniforms;
// - aerial perspective: ref.raw (Navara's Effect) .rawEffect.uniforms (a Map);
// - clouds: ref.raw.rawEffect.cloudsPass.currentMaterial.uniforms (the
//   clouds swap that material when their quality changes).
//
// Re-check each path before moving to another Navara version (as for
// internals.js). Upstream ask: a sky luminance or atmosphere exposure that
// leaves unlit content (the baked tiles) alone.

export const LUMINANCE_UNIFORMS = Object.freeze([
  'SUN_SPECTRAL_RADIANCE_TO_LUMINANCE',
  'SKY_SPECTRAL_RADIANCE_TO_LUMINANCE',
]);

const uniformsOf = {
  sky: (raw) => raw?.material?.uniforms,
  aerialPerspective: (raw) => raw?.rawEffect?.uniforms,
  clouds: (raw) => raw?.rawEffect?.cloudsPass?.currentMaterial?.uniforms,
};

const get = (uniforms, name) =>
  uniforms instanceof Map ? uniforms.get(name) : uniforms?.[name];

/**
 * Scales the atmosphere's luminance factors to `scale` times the values
 * their materials were built with. Idempotent: each factor's vector is
 * scaled once (Navara 0.2.1 shares one vector between the sky, the aerial
 * perspective and the clouds), and a material Navara rebuilds with a new
 * vector is scaled when it first shows.
 * @returns {(handles: { sky?: object, aerialPerspective?: object, clouds?: object }) => boolean}
 *   applies the scale; true when it changed a uniform.
 */
export function createAtmosphereLuminance(scale) {
  const scaled = new WeakSet();
  return (handles) => {
    if (scale === 1) return false;
    let changed = false;
    for (const [name, read] of Object.entries(uniformsOf)) {
      const uniforms = read(handles[name]?.ref?.raw);
      if (!uniforms) continue;
      for (const key of LUMINANCE_UNIFORMS) {
        const uniform = get(uniforms, key);
        const value = uniform?.value;
        if (!value || typeof value.multiplyScalar !== 'function') continue;
        // Navara's materials share one vector per factor: scale it once.
        if (scaled.has(value)) continue;
        value.multiplyScalar(scale);
        scaled.add(value);
        changed = true;
      }
    }
    return changed;
  };
}

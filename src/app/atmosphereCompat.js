/**
 * Workaround for Apple's Metal/ANGLE shader translator rejecting Cesium's
 * per-vertex model atmosphere.
 *
 * Cesium's `AtmosphereStageVS` calls a function whose `out` parameters are
 * bound DIRECTLY to varyings:
 *
 *   czm_computeGroundAtmosphereScattering(
 *       v_positionWC, lightDirection,
 *       v_atmosphereRayleighColor, v_atmosphereMieColor, v_atmosphereOpacity);
 *
 * ANGLE's Metal backend wraps each `out` argument in an `ANGLE_out(...)`
 * helper that takes a `thread T &`. Vertex-output struct members live in
 * `__metal_generic`, which cannot bind to `thread`, so the program fails to
 * LINK (not compile) and Cesium tears the render loop down:
 *
 *   RuntimeError: Program failed to link. ... MSL compilation error:
 *   reference to type 'thread float3' could not bind to an lvalue of type
 *   '__metal_generic float3'
 *
 * This is the only shader in Cesium that binds varyings to `out` params --
 * SkyAtmosphere and the ground-atmosphere fragment path both route through
 * locals first, so they are unaffected and stay on.
 *
 * Cesium attaches that stage in `ModelSceneGraph.configurePipeline` under a
 * single condition:
 *
 *   const fogRenderable = frameState.fog.enabled && frameState.fog.renderable;
 *   if (fogRenderable) modelPipelineStages.push(AtmospherePipelineStage);
 *
 * so clearing `scene.fog.renderable` keeps the broken stage out of the
 * pipeline entirely -- the program is never built, so it cannot fail to link.
 *
 * We clear `renderable` rather than `enabled` deliberately:
 *   - `Fog.update` still computes fog density when only `renderable` is off,
 *     preserving the distance-based screen-space-error scaling that governs
 *     3D Tiles refinement. Clearing `enabled` returns early and forfeits it.
 *   - `visualSettings.js` saves and restores `scene.fog.enabled` around IR
 *     boost. Parking our fix on `enabled` would let that restore resurrect
 *     the broken shader mid-session; `renderable` is orthogonal to it.
 *
 * @module app/atmosphereCompat
 */

/** Minimal vertex shader reproducing the exact out-param-to-varying bind. */
const PROBE_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec3 a_position;
out vec3 v_probe;
void writeOut(out vec3 value) { value = vec3(1.0); }
void main() {
  writeOut(v_probe);
  gl_Position = vec4(a_position, 1.0);
}`;

const PROBE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_probe;
out vec4 fragColor;
void main() { fragColor = vec4(v_probe, 1.0); }`;

/**
 * True when the user agent is iOS or iPadOS.
 *
 * iPadOS 13+ defaults to desktop-mode browsing and reports `MacIntel` with no
 * iPad token, so it is identified by touch points instead -- real Macs report
 * `maxTouchPoints` of 0, including Apple Silicon ones that also claim
 * `MacIntel`. Brave/Chrome/Firefox on iOS are all WebKit underneath and share
 * the same Metal backend, so matching the platform rather than the browser is
 * what we want.
 */
export function isAppleMobilePlatform(navigatorLike = globalThis.navigator) {
  if (!navigatorLike) return false;
  const ua = String(navigatorLike.userAgent || '');
  if (/\b(iPad|iPhone|iPod)\b/.test(ua)) return true;
  // Desktop-mode iPadOS presents as a Mac. What separates it from a real Mac
  // is touch: Macs report 0 touch points, including Apple Silicon ones that
  // also claim `MacIntel`. `navigator.platform` is deprecated and may be
  // empty, so the UA's Macintosh token is accepted as an equal signal rather
  // than relying on platform alone.
  const platform = String(navigatorLike.platform || '');
  const macLike =
    platform === 'MacIntel' ||
    platform === 'MacARM' ||
    /\bMacintosh\b/.test(ua);
  const touchPoints = Number(navigatorLike.maxTouchPoints) || 0;
  return macLike && touchPoints > 1;
}

/**
 * Link the probe program and report whether the driver rejects the pattern.
 *
 * Returns `false` when WebGL2 is unavailable so that a missing context is
 * never mistaken for a broken driver -- Cesium has its own handling for that,
 * and the caller still falls back to platform detection.
 */
export function probeOutParamVaryingLinkFailure(gl) {
  if (!gl) return false;
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return false;
  try {
    gl.shaderSource(vs, PROBE_VERTEX_SHADER);
    gl.compileShader(vs);
    gl.shaderSource(fs, PROBE_FRAGMENT_SHADER);
    gl.compileShader(fs);
    // A compile failure here is not the bug we are probing for: the driver
    // rejects this pattern at LINK time, after both stages compile cleanly.
    if (
      !gl.getShaderParameter(vs, gl.COMPILE_STATUS) ||
      !gl.getShaderParameter(fs, gl.COMPILE_STATUS)
    )
      return false;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    return !gl.getProgramParameter(program, gl.LINK_STATUS);
  } catch {
    return false;
  } finally {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(program);
  }
}

/** Build a throwaway WebGL2 context for the probe, or null if unavailable. */
function defaultProbeContext() {
  try {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(1, 1)
        : globalThis.document?.createElement('canvas');
    return canvas?.getContext('webgl2') ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide whether the per-vertex model atmosphere must be kept out of the
 * pipeline on this device.
 *
 * The probe is authoritative when it fires, so a future driver fix silently
 * restores the effect without a code change. Platform detection is the
 * backstop for the case where no context can be created -- on Apple mobile a
 * link failure is fatal and unrecoverable, so we would rather lose fog than
 * gamble the whole render loop on the probe having run.
 */
export function shouldDisableModelAtmosphere({
  navigatorLike = globalThis.navigator,
  createProbeContext = defaultProbeContext,
} = {}) {
  const gl = createProbeContext();
  if (gl) {
    let linkFails;
    try {
      linkFails = probeOutParamVaryingLinkFailure(gl);
    } finally {
      // Browsers cap live WebGL contexts (Safari especially); release the
      // throwaway probe context now rather than waiting for GC.
      try {
        gl.getExtension?.('WEBGL_lose_context')?.loseContext();
      } catch {
        // A context that cannot be released is left to GC.
      }
    }
    if (linkFails) return true;
    // Probe ran and the driver accepted the pattern. Apple mobile is still
    // quarantined: the probe program is far simpler than Cesium's, and a
    // false negative there costs the entire scene.
    return isAppleMobilePlatform(navigatorLike);
  }
  return isAppleMobilePlatform(navigatorLike);
}

/**
 * Keep Cesium's broken model-atmosphere stage out of the pipeline.
 *
 * Returns true when the workaround was applied. Safe to call on any scene;
 * scenes without a fog object are left untouched.
 */
export function applyModelAtmosphereWorkaround(scene, options = {}) {
  if (!scene?.fog) return false;
  if (!shouldDisableModelAtmosphere(options)) return false;
  scene.fog.renderable = false;
  return true;
}

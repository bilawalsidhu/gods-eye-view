/**
 * The Cesium scene's frame depth for the occlusion probe
 * (`src/render/occlusion/depthProbe.js`): the query port's `occlusionTest`
 * on Cesium. The scene already keeps the depth of the frame it has just drawn
 * (for picking), packed four bytes to a texel, one texture per depth range.
 *
 * Every read of renderer internals is in `readSceneDepthSource` below.
 */
import * as Cesium from 'cesium';
import {
  createDepthOcclusionTest,
  DepthOcclusionProbe,
  PROBE_MAX_FRUSTUMS,
} from '../occlusion/depthProbe.js';
import {
  rawFramebuffer,
  rawTexture,
  usesGlobeDepthFramebuffer,
  webglContext,
} from './internals.js';

export {
  PROBE_MAX_CONTROL_FAILURES,
  PROBE_MAX_FRUSTUMS,
  PROBE_MAX_PENDING_FRAMES,
  PROBE_MAX_PER_FRAME,
  PROBE_RETRY_AFTER_MS,
  PROBE_VERTEX_SHADER,
  SYNC_READ_INTERVAL_MS,
} from '../occlusion/depthProbe.js';

/**
 * Everything this module takes from the renderer, in one place.
 *
 * RENDERER INTERNALS. Checked against cesium 1.138.0 (@cesium/engine 22.3.0);
 * re-check on an engine upgrade. Undocumented members used, and what each is
 * assumed to be:
 *
 * - `scene.context._gl`: the WebGL context. `scene.context.webgl2` says which.
 * - `scene.view.frustumCommandsList[i].near` / `.far`: the depth ranges the
 *   last frame was drawn in, nearest first.
 * - `scene.view.pickDepths[i].framebuffer`: one framebuffer per depth range,
 *   refreshed every frame while `scene.useDepthPicking` is on and
 *   `scene._environmentState.useGlobeDepthFramebuffer` is true, whose first
 *   colour attachment is an RGBA8 texture holding window-space depth packed
 *   four bytes to a texel (`czm_packDepth`; see `unpackDepth`).
 *   `framebuffer._framebuffer` is the raw WebGL framebuffer, and
 *   `framebuffer.getColorTexture(0)` the texture (`._texture` its raw handle).
 * - Opaque geometry in every range but the nearest is drawn with its near
 *   plane pulled in by `scene.opaqueFrustumNearOffset` (public), exactly as
 *   `scene.pickPosition` assumes when it decodes the same textures.
 * - `scene.frameState.useLogDepth`: whether depth is logarithmic (see
 *   `depthToViewDistance`). Anything but a boolean there is "no depth".
 *
 * Any of these missing or shaped differently returns null, which callers treat
 * as "no depth".
 *
 * @param {Cesium.Scene} scene
 * @param {Float64Array} [viewScratch] Sixteen numbers to write the view matrix
 *   into instead of allocating; the result's `view` is then this array.
 * @returns {null | {
 *   gl: WebGLRenderingContext|WebGL2RenderingContext, webgl2: boolean,
 *   width: number, height: number, framebuffers: WebGLFramebuffer[],
 *   textures: WebGLTexture[],
 *   frustums: Array<{near: number, far: number}>, logDepth: boolean,
 *   view: Float64Array, tanHalfFovX: number, tanHalfFovY: number,
 * }}
 */
export function readSceneDepthSource(scene, viewScratch) {
  try {
    if (!scene || scene.mode !== Cesium.SceneMode.SCENE3D) return null;
    if (scene.useDepthPicking !== true) return null;
    const context = scene.context;
    const gl = webglContext(scene);
    if (!gl || context.depthTexture !== true) return null;
    if (usesGlobeDepthFramebuffer(scene) !== true) return null;

    const camera = scene.camera;
    const frustum = camera?.frustum;
    const fovy = frustum?.fovy;
    const aspectRatio = frustum?.aspectRatio;
    if (!(fovy > 0 && fovy < Math.PI) || !(aspectRatio > 0)) return null;
    if (frustum.xOffset || frustum.yOffset) return null;

    const view = scene.view;
    const ranges = view?.frustumCommandsList;
    const pickDepths = view?.pickDepths;
    if (!ranges?.length || !pickDepths?.length) return null;
    const count = Math.min(
      ranges.length,
      pickDepths.length,
      PROBE_MAX_FRUSTUMS,
    );
    const nearOffset = Number(scene.opaqueFrustumNearOffset) || 1;
    const framebuffers = [];
    const textures = [];
    const frustums = [];
    let width = 0;
    let height = 0;
    for (let i = 0; i < count; i++) {
      const framebuffer = pickDepths[i]?.framebuffer;
      const raw = rawFramebuffer(framebuffer);
      const texture = framebuffer?.getColorTexture?.(0);
      const near = ranges[i]?.near * (i === 0 ? 1 : nearOffset);
      const far = ranges[i]?.far;
      if (!raw || !rawTexture(texture) || !(near > 0) || !(far > near))
        return null;
      if (i === 0) {
        width = texture.width;
        height = texture.height;
      } else if (texture.width !== width || texture.height !== height) {
        return null;
      }
      framebuffers.push(raw);
      textures.push(rawTexture(texture));
      frustums.push({ near, far });
    }
    if (!(width > 0) || !(height > 0)) return null;
    // Read as standard depth, logarithmic depth puts every surface a few
    // metres from the camera and would hide every contact: unknown is "no".
    const logDepth = scene.frameState?.useLogDepth;
    if (typeof logDepth !== 'boolean') return null;

    const tanHalfFovY = Math.tan(fovy / 2);
    return {
      gl,
      webgl2: context.webgl2 === true,
      width,
      height,
      framebuffers,
      textures,
      frustums,
      logDepth,
      view: Cesium.Matrix4.toArray(
        camera.viewMatrix,
        viewScratch || new Float64Array(16),
      ),
      tanHalfFovX: tanHalfFovY * aspectRatio,
      tanHalfFovY,
    };
  } catch {
    return null;
  }
}

/** The occlusion probe on a Cesium scene's depth (`readSceneDepthSource`). */
export class SceneOcclusionProbe extends DepthOcclusionProbe {
  /**
   * @param {{
   *   now?: () => number,
   *   readSource?: typeof readSceneDepthSource,
   * }} [options]
   */
  constructor({ now, readSource = readSceneDepthSource } = {}) {
    super({ readSource, ...(now ? { now } : {}) });
  }
}

/**
 * The query port's `occlusionTest()` on `scene`: a probe whose
 * `beginFrame(now)` reads the scene itself (none once it is destroyed); the
 * rest is the probe's.
 * @param {object} scene A Cesium scene.
 * @returns {import('../contract/query').OcclusionTest}
 */
export function createSceneOcclusionTest(scene) {
  return createDepthOcclusionTest({
    readSource: readSceneDepthSource,
    target: () => (scene.isDestroyed?.() ? null : scene),
  });
}

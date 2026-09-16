/**
 * WebGL context attributes for the Cesium viewer (render-perf five, items 1
 * and 2 — docs/PLAN.md). Split out of main.js so the policy is unit-testable
 * and the escape hatches are documented beside the code that reads them.
 *
 * preserveDrawingBuffer (default OFF):
 *   Keeping the drawing buffer alive after compositing costs a preserved
 *   back buffer plus a compositor copy for every frame of a continuously
 *   rendering 3D scene — paid always, read ~never. The app's one in-process
 *   pixel reader, the voice-vision snapshot, captures with the
 *   render-then-blit-in-the-same-task pattern (requestRender → await
 *   postRender → drawImage in the task's microtask checkpoint), which is
 *   black-frame-safe WITHOUT preservation (verified against a live globe by
 *   scripts/profile-render-perf.mjs, `capture` section: FRAME-CAPTURED with
 *   the attribute off). External grabbers that need late readback can
 *   restore the old behavior with ?preserveBuffer=1.
 *
 * msaaSamples (default 2, was 4):
 *   4× MSAA stores 4 samples per pixel for the scene's multisample target
 *   (a 1440×900 buffer is ~19.8 MiB at 4× vs ~9.9 MiB at 2×) and multiplies
 *   the per-frame resolve bandwidth. Tile imagery hides the difference: at
 *   2× the globe edges stay clean, and the aliasing 2× cannot resolve lives
 *   in fine billboard/text geometry that MSAA barely helps. ?msaa=N forces
 *   a specific sample count (1 disables MSAA) for A/B capture.
 *
 * @param {object} [options]
 * @param {string} [options.search] Query string to read overrides from
 *   (defaults to the live location, injectable for tests).
 * @returns {{msaaSamples: number, contextOptions: {webgl: {preserveDrawingBuffer: boolean}}}}
 *   Spread directly into the Cesium Viewer constructor options.
 */

export const DEFAULT_MSAA_SAMPLES = 2;

/**
 * Resolve the WebGL context attributes for the viewer, honoring the
 * `?msaa=` / `?preserveBuffer=` escape hatches described above.
 * @param {object} [options] - Injection seam; defaults read the live URL.
 * @param {string} [options.search] Query string to read overrides from
 *   (defaults to the live location, injectable for tests).
 * @returns {{msaaSamples: number, contextOptions: {webgl: {preserveDrawingBuffer: boolean}}}}
 *   Spread directly into the Cesium Viewer constructor options.
 */
export function resolveRenderContextOptions({ search = globalThis.location?.search ?? '' } = {}) {
  const params = new URLSearchParams(search);

  const msaaOverride = Number(params.get('msaa'));
  const msaaSamples = Number.isFinite(msaaOverride) && msaaOverride >= 1
    ? Math.min(8, Math.round(msaaOverride))
    : DEFAULT_MSAA_SAMPLES;

  const preserveDrawingBuffer = params.get('preserveBuffer') === '1';

  return {
    msaaSamples,
    contextOptions: {
      webgl: {
        preserveDrawingBuffer,
      },
    },
  };
}

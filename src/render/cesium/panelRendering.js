/**
 * @module render/cesium/panelRendering
 * @description Keeping the Cesium viewer drawing in an inline panel whose
 * host stops animation frames (`src/app/embed.js`, embed mode). The
 * application scene hands it to the embed views (`src/app/scene.js`).
 */

// A panel keeps drawing at about this rate when its host stops animation
// frames; see keepPanelRendering.
const PANEL_FRAME_MS = 33;
const MISSED_FRAMES_MS = 250;

/** A render error's details, including the plain objects workers report. */
function describeError(error) {
  if (error instanceof Error)
    return `${error.name}: ${error.message}\n${error.stack}`;
  try {
    return JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}));
  } catch {
    return String(error);
  }
}

/**
 * Keep the globe drawing in an inline panel. Some hosts report a panel on
 * screen as hidden, which stops the browser's animation frames and with them
 * Cesium's render loop; while frames stop arriving, draw from a timer.
 * Returns a function that stops it.
 */
export function keepPanelRendering(
  viewer,
  { windowRef = globalThis.window, now = () => performance.now() } = {},
) {
  let lastFrame = now();
  let frameRequest = null;
  const onFrame = () => {
    lastFrame = now();
    frameRequest = windowRef.requestAnimationFrame(onFrame);
  };
  frameRequest = windowRef.requestAnimationFrame(onFrame);
  // Cesium stops drawing after a render error, and so does the timer.
  // Report the error in full: workers report plain objects, which Cesium
  // prints as [object Object].
  let failed = false;
  const removeErrorListener = viewer.scene?.renderError?.addEventListener(
    (_scene, error) => {
      failed = true;
      console.error(
        "[God's Eye View panel] render error:",
        describeError(error),
      );
    },
  );
  const timer = windowRef.setInterval(() => {
    if (
      failed ||
      now() - lastFrame < MISSED_FRAMES_MS ||
      viewer.isDestroyed?.()
    )
      return;
    viewer.resize();
    viewer.render();
  }, PANEL_FRAME_MS);
  return () => {
    windowRef.clearInterval(timer);
    windowRef.cancelAnimationFrame(frameRequest);
    removeErrorListener?.();
  };
}

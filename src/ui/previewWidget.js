// The card previews (the turning model, the route globe) each draw in a
// small Cesium scene of their own, so each holds a WebGL context. A browser
// keeps only a handful of those open, and when there are too many it drops
// the oldest, which is the main globe's. A destroyed widget's context is
// otherwise freed only when garbage is collected, so flicking through cards
// can push the globe's context out. Losing a preview's context on purpose as
// it closes frees it at once.

/**
 * Destroy a preview's Cesium widget and free its WebGL context.
 * @param {object|null} widget a Cesium CesiumWidget
 */
export function destroyPreviewWidget(widget) {
  if (!widget || widget.isDestroyed?.()) return;
  let gl = null;
  try {
    gl =
      widget.scene?.context?._gl ??
      widget.canvas?.getContext?.('webgl2') ??
      null;
  } catch {
    gl = null;
  }
  widget.destroy();
  try {
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
  } catch {
    // Nothing more can be done; the context goes when it is collected.
  }
}

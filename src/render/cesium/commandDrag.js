/**
 * @module render/cesium/commandDrag
 * @description On macOS, Command+drag on the globe runs the camera
 * controller's Ctrl+drag (tilt and rotate). Ctrl+click is a right click
 * there, so Ctrl+drag is awkward; Ctrl+drag still works as before.
 *
 * Cesium reads a drag's modifier from each DOM event's `ctrlKey` and has
 * no Command modifier, so pointer and mouse events with Command held and
 * Ctrl not held are made to report `ctrlKey` before Cesium's handler hears
 * them: those over the canvas, and the moves and releases of a press that
 * began there. Wheel events are never touched: Ctrl+wheel is the trackpad
 * pinch on macOS. Other platforms are left as they are.
 */

/** The pointer and mouse events Cesium's handler reads a modifier from. */
const DRAG_EVENTS = Object.freeze([
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mousemove',
  'mouseup',
]);
const ENDS = new Set(['pointerup', 'pointercancel', 'mouseup']);
const STARTS = new Set(['pointerdown', 'mousedown']);

/**
 * Whether the browser runs on macOS (or an iPad or iPhone with a keyboard),
 * where Command takes Ctrl's place.
 * @param {{platform?: string, userAgentData?: {platform?: string}}} [nav]
 */
export function isMacPlatform(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad|ipod/i.test(String(platform));
}

/**
 * Make Command+drag on a viewer's canvas count as Ctrl+drag on macOS;
 * returns its disposer. Elsewhere it installs nothing.
 * @param {{canvas: object}} viewer A Cesium `Viewer` or `CesiumWidget`.
 * @param {object} [options]
 * @param {boolean} [options.mac] Whether to remap; the browser's platform
 *   says when omitted.
 * @param {object} [options.document] Where the events are watched, ahead
 *   of Cesium's own listeners (the canvas's document when omitted).
 */
export function installCommandDrag(
  viewer,
  { mac = isMacPlatform(), document } = {},
) {
  const canvas = viewer?.canvas;
  if (!canvas) throw new TypeError('A viewer with a canvas is required');
  const dom = document ?? canvas.ownerDocument ?? globalThis.document;
  if (!mac || !dom?.addEventListener) return () => {};

  // A Command press that began on the canvas, until it is let go.
  let pressing = false;
  const onCanvas = (target) =>
    target === canvas || Boolean(canvas.contains?.(target));
  const remap = (event) => {
    const start = STARTS.has(event.type);
    const command = event.metaKey && !event.ctrlKey;
    if (command && (pressing || onCanvas(event.target))) {
      Object.defineProperty(event, 'ctrlKey', {
        value: true,
        configurable: true,
      });
      if (start) pressing = true;
    }
    if (ENDS.has(event.type) && !(event.buttons > 0)) pressing = false;
  };
  for (const type of DRAG_EVENTS)
    dom.addEventListener(type, remap, { capture: true, passive: true });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const type of DRAG_EVENTS)
      dom.removeEventListener(type, remap, { capture: true });
  };
}

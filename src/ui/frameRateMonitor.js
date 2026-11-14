import { useStatusStore } from './stores/status.js';
import { applicationPinia } from './vueRuntime.js';

/**
 * Count rendered globe frames while the optional readout is visible. The
 * readout is presented to the status store, which the title bar renders.
 */
export function createFrameRateMonitor({
  viewer,
  documentRef = document,
  store = useStatusStore(applicationPinia()),
}) {
  const frameEvent = viewer?.scene?.postRender;
  // A page without the scene chrome has no title bar to show it in.
  if (!documentRef.getElementById('title-bar') || !frameEvent)
    return { destroy() {} };

  // i18n-ignore: FPS is a unit code, the same in every language
  let readout = { visible: false, text: 'FPS —' };
  // Each monitor shows its readout until a newer one takes the title bar.
  store.publishFps(readout);
  const present = (patch) => {
    const shown = store.fps === readout;
    readout = { ...readout, ...patch };
    if (shown) store.publishFps(readout);
  };
  let removeFrameListener = null;
  let timer = null;
  let frames = 0;
  let startedAt = 0;
  let destroyed = false;

  function hide() {
    present({ visible: false });
    removeFrameListener?.();
    removeFrameListener = null;
    clearInterval(timer);
    timer = null;
  }

  function show() {
    frames = 0;
    startedAt = performance.now();
    // i18n-ignore: FPS is a unit code, the same in every language
    present({ visible: true, text: 'FPS —' });
    removeFrameListener = frameEvent.addEventListener(() => {
      frames++;
    });
    timer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - startedAt;
      present({
        text:
          // i18n-ignore: FPS is a unit code, the same in every language
          documentRef.hidden || elapsed <= 0
            ? 'FPS —'
            : `FPS ${Math.round((frames * 1000) / elapsed)}`,
      });
      frames = 0;
      startedAt = now;
    }, 1000);
  }

  function onKeyDown(event) {
    if (event.key !== '`' && event.code !== 'Backquote') return;
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    if (
      event.target?.isContentEditable ||
      event.target?.closest?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
    event.preventDefault();
    if (readout.visible) hide();
    else show();
  }

  documentRef.addEventListener('keydown', onKeyDown);
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      hide();
      documentRef.removeEventListener('keydown', onKeyDown);
      // A newer monitor's readout stays.
      if (store.fps === readout) store.publishFps(null);
    },
  };
}

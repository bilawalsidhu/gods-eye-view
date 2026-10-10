/** Count rendered globe frames while the optional readout is visible. */
import { subscribeLocale, t } from '../i18n/index.js';

export function createFrameRateMonitor({ viewer, documentRef = document }) {
  const host = documentRef.getElementById('title-bar');
  const frameEvent = viewer?.scene?.postRender;
  if (!host || !frameEvent) return { destroy() {} };

  const readout = documentRef.createElement('div');
  readout.className = 'frame-rate-readout';
  readout.hidden = true;
  readout.textContent = t('hud.fps.idle');
  readout.title = t('hud.fps.title');
  host.appendChild(readout);
  let removeFrameListener = null;
  let timer = null;
  let frames = 0;
  let startedAt = 0;
  let destroyed = false;

  // The readout is created once; FPS is an international abbreviation and
  // stays, but the title and the idle text translate. While visible the value
  // repaints every second anyway, so a locale switch only needs one repaint.
  const unsubscribeLocale = subscribeLocale(() => {
    readout.title = t('hud.fps.title');
    if (!readout.hidden) {
      const now = performance.now();
      const elapsed = now - startedAt;
      readout.textContent =
        documentRef.hidden || elapsed <= 0
          ? t('hud.fps.idle')
          : t('hud.fps.value', {
              n: Math.round((frames * 1000) / elapsed),
            });
    }
  });

  function paintIdle() {
    readout.textContent = t('hud.fps.idle');
  }

  function hide() {
    readout.hidden = true;
    removeFrameListener?.();
    removeFrameListener = null;
    clearInterval(timer);
    timer = null;
  }

  function show() {
    frames = 0;
    startedAt = performance.now();
    paintIdle();
    readout.hidden = false;
    removeFrameListener = frameEvent.addEventListener(() => {
      frames++;
    });
    timer = setInterval(() => {
      const now = performance.now();
      const elapsed = now - startedAt;
      readout.textContent =
        documentRef.hidden || elapsed <= 0
          ? t('hud.fps.idle')
          : t('hud.fps.value', { n: Math.round((frames * 1000) / elapsed) });
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
    if (readout.hidden) show();
    else hide();
  }

  documentRef.addEventListener('keydown', onKeyDown);
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeLocale();
      hide();
      documentRef.removeEventListener('keydown', onKeyDown);
      readout.remove();
    },
  };
}

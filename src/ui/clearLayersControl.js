/** Keep the clear action focusable while busy; the caller owns its transaction. */
import { t } from '../i18n/index.js';

export function bindClearLayersControl(button, clear) {
  let destroyed = false;
  const click = () => {
    if (!destroyed) void clear();
  };
  button?.addEventListener('click', click);
  return {
    setBusy(busy) {
      if (destroyed || !button) return;
      button.setAttribute('aria-disabled', String(busy));
      button.setAttribute('aria-busy', String(busy));
      button.setAttribute(
        'aria-label',
        busy ? t('layers.clear.busy') : t('chrome.actions.clearLayers'),
      );
    },
    destroy() {
      destroyed = true;
      button?.removeEventListener('click', click);
    },
  };
}

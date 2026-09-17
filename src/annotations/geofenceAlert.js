/**
 * Geofence visual alert: shows banner on breach, hides on dismiss.
 * Pure DOM helper, no Cesium.
 */

export function createGeofenceAlert({
  alertEl,
  textEl,
  dismissBtn,
  autoHideMs = 8000,
} = {}) {
  const resolve = (el, id) => {
    if (el) return el;
    try {
      if (typeof document !== 'undefined') return document.getElementById(id);
    } catch {}
    return null;
  };
  alertEl = resolve(alertEl, 'geofence-alert');
  textEl = resolve(textEl, 'geofence-alert-text');
  dismissBtn = resolve(dismissBtn, 'geofence-alert-dismiss');
  let timer = null;
  let destroyed = false;

  const hide = () => {
    if (!alertEl) return;
    alertEl.classList.remove('visible');
    // keep hidden attr for a11y after transition
    setTimeout(() => {
      if (!alertEl.classList.contains('visible')) alertEl.hidden = true;
    }, 300);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const show = (message) => {
    if (destroyed || !alertEl) return;
    if (textEl && message) textEl.textContent = message;
    alertEl.hidden = false;
    // force reflow for transition
    void alertEl.offsetWidth;
    alertEl.classList.add('visible');
    if (timer) clearTimeout(timer);
    if (autoHideMs > 0) {
      timer = setTimeout(hide, autoHideMs);
    }
  };

  const onDismiss = () => hide();
  dismissBtn?.addEventListener('click', onDismiss);

  return {
    show,
    hide,
    destroy: () => {
      destroyed = true;
      if (timer) clearTimeout(timer);
      dismissBtn?.removeEventListener('click', onDismiss);
    },
    isVisible: () => !!alertEl?.classList.contains('visible'),
  };
}

export function formatBreachMessage(entity) {
  const id = entity?.id ?? entity?.entityId ?? 'Unknown';
  return `GEOFENCE BREACH — ${id}`;
}

/**
 * Globe mode toggle — 3D globe vs flat 2D map.
 *
 * The 2D map is dramatically lighter on weak GPUs (no 3D tileset, no
 * atmosphere post-processing), which makes it the right escape hatch on
 * tablets and older hardware. Cesium morphs between modes; the layers
 * already guard on `scene.mode` and degrade gracefully outside 3D.
 *
 * Session-local on purpose: it is a performance preference for this device,
 * not a view worth serializing into share links.
 */
export function createGlobeModeController({ viewer, button, showToast } = {}) {
  const scene = viewer?.scene;
  if (!scene || !button) return null;
  let flat = false;
  let destroyed = false;

  const label = button.querySelector('.pp-label');

  function sync() {
    button.classList.toggle('active', !flat);
    button.setAttribute('aria-pressed', String(!flat));
    button.setAttribute('aria-label', `Globe mode: ${flat ? '2D' : '3D'}`);
    if (label) label.textContent = flat ? '2D' : '3D';
  }

  function toggle() {
    if (destroyed) return false;
    const next = !flat;
    try {
      if (next) scene.morphTo2D(1.5);
      else scene.morphTo3D(1.5);
    } catch {
      showToast?.('Globe mode unavailable');
      return false;
    }
    flat = next;
    sync();
    showToast?.(flat ? '2D map — lighter on this device' : '3D globe');
    return true;
  }

  sync();
  return {
    toggle,
    isFlat: () => flat,
    destroy() {
      destroyed = true;
    },
  };
}

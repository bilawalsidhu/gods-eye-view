import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
/** Resolve overlapping loaded records, never aggregate representatives. */
export function recordsAtPixel(viewer, entities, pixel, radius = 10) {
  const now = Cesium.JulianDate.now();
  return entities
    .flatMap((entity) => {
      const pos = entity.position?.getValue?.(now);
      const point = pos && viewer.scene.cartesianToCanvasCoordinates?.(pos);
      const distance = point
        ? Math.hypot(point.x - pixel.x, point.y - pixel.y)
        : Infinity;
      return distance <= radius ? [{ entity, distance }] : [];
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        String(a.entity.id).localeCompare(String(b.entity.id)),
    )
    .map((x) => x.entity);
}
export function createRecordPicker(onSelect) {
  let dialog, previous;
  function close() {
    if (!dialog) return;
    dialog.close?.();
    dialog.remove();
    dialog = undefined;
    if (previous?.isConnected) previous.focus();
  }
  function choose(entities) {
    close();
    if (entities.length === 1) return onSelect(entities[0]);
    if (!entities.length || typeof document === 'undefined') return false;
    previous = document.activeElement;
    dialog = document.createElement('dialog');
    dialog.className = 'gev-panel';
    Object.assign(dialog.style, {
      position: 'fixed',
      left: '50%',
      top: '50%',
      right: 'auto',
      bottom: 'auto',
      margin: '0',
      transform: 'translate(-50%, -50%)',
      width: 'min(28rem, calc(100vw - 32px))',
      boxSizing: 'border-box',
      fontFamily: 'var(--font-mono, monospace)',
      fontSize: '12px',
      lineHeight: '1.5',
      background: '#0b1018',
      color: '#dbe4ea',
      border: '1px solid #33434c',
      borderRadius: '12px',
      padding: '16px',
      maxWidth: 'min(28rem, calc(100vw - 32px))',
      maxHeight: '75vh',
    });
    const heading = document.createElement('h3');
    heading.id = 'well-record-choice-title';
    Object.assign(heading.style, { fontSize: '14px', margin: '0 0 8px' });
    heading.textContent = t('Source records at this location');
    dialog.setAttribute('aria-labelledby', heading.id);
    const note = document.createElement('p');
    note.textContent = t(
      'These records may describe the same physical well. Choose a source record.',
    );
    const select = document.createElement('select');
    select.className = 'gev-field';
    select.setAttribute('aria-label', t('Source record'));
    select.style.maxWidth = '100%';
    for (const entity of entities) {
      const option = document.createElement('option');
      option.value = entity.id;
      option.textContent =
        entity.gevWellRecordLabel ||
        entity.gevLabelModel?.title ||
        entity.name ||
        entity.id;
      select.append(option);
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'gev-action-button';
    open.textContent = t('View record');
    open.addEventListener('click', () => {
      const entity = entities.find((e) => e.id === select.value);
      close();
      if (entity) onSelect(entity);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'gev-action-button';
    cancel.textContent = t('Cancel');
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', close);
    dialog.append(heading, note, select, open, cancel);
    document.body.append(dialog);
    dialog.showModal();
    select.focus();
    return true;
  }
  return { choose, close };
}

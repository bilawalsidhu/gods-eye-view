import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { validateCountView } from './countGrids.js';

export const circleDiameter = () => 10;
export const circleLabel = () => '';
export const WELL_DETAIL_HEIGHT = 50000;
const SOURCE = 'us-groundwater-counts';
export function padGroupBounds(bounds) {
  const b = [...bounds];
  const minSpan = 0.01;
  const longitudeSpan = b[2] - b[0] === 360 ? 360 : (b[2] - b[0] + 360) % 360;
  if (longitudeSpan < minSpan) {
    const mid = ((b[0] + longitudeSpan / 2 + 540) % 360) - 180;
    b[0] = ((mid - minSpan / 2 + 540) % 360) - 180;
    b[2] = ((mid + minSpan / 2 + 540) % 360) - 180;
  }
  if (b[3] - b[1] < minSpan) {
    const mid = (b[1] + b[3]) / 2;
    b[1] = Math.max(-90, Math.min(90 - minSpan, mid - minSpan / 2));
    b[3] = b[1] + minSpan;
  }
  return b;
}
export function wellMarkerImage(hasReadings, uncertain = false) {
  const fill = uncertain ? 'none' : hasReadings ? '#56b4e9' : '#c6d0d4';
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="${fill}" stroke="${uncertain ? '#f5b942' : '#071b25'}" stroke-width="2"/></svg>`,
    )
  );
}
/** Counts remain transport evidence; only admitted source positions are rendered. */
export function createCountRenderer(
  viewer,
  { overlays, onSelectRecord = () => {} } = {},
) {
  let source,
    removeFrame,
    removeEnd,
    controls,
    signature = '';
  let focusLabel, instructions;
  function hideFocusLabel() {
    focusLabel?.remove();
    focusLabel = undefined;
  }
  function revealFocusLabel(button) {
    if (!document.body) return;
    if (!focusLabel) {
      focusLabel = document.createElement('div');
      focusLabel.className = 'gev-panel';
      Object.assign(focusLabel.style, {
        position: 'fixed',
        zIndex: '1000',
        bottom: '110px',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100vw - 32px)',
        padding: '8px 12px',
        background: '#0b1018',
        color: '#dbe4ea',
        border: '1px solid #33434c',
        borderRadius: '8px',
        fontFamily: 'monospace',
        fontSize: '12px',
      });
      document.body.append(focusLabel);
    }
    focusLabel.textContent = t(
      '{record} · Enter: inspect record · Arrow keys: move',
      { record: button.textContent },
    );
  }
  function focusMap() {
    const canvas = viewer.scene.canvas;
    if (typeof canvas?.focus === 'function') {
      canvas.tabIndex = 0;
      canvas.focus();
    } else document.querySelector('#data-panel .panel-collapse-btn')?.focus();
  }
  function removeControls() {
    if (controls?.contains(document.activeElement)) focusMap();
    hideFocusLabel();
    controls?.remove();
    controls = undefined;
    instructions?.remove();
    instructions = undefined;
    signature = '';
  }
  function publish() {
    if (!source) return;
    const near =
      (viewer.camera.positionCartographic?.height ?? Infinity) <=
      WELL_DETAIL_HEIGHT;
    source.show = near;
    if (typeof document === 'undefined') return;
    const records = near
      ? source.entities.values.filter(
          (e) => !String(e.id).startsWith('well-cell:'),
        )
      : [];
    const visible = records.filter((e) => {
      const pos = e.position?.getValue?.(Cesium.JulianDate.now());
      const p = pos && viewer.scene.cartesianToCanvasCoordinates?.(pos);
      const c = viewer.scene.canvas;
      return (
        p &&
        c &&
        p.x >= 0 &&
        p.y >= 0 &&
        p.x <= c.clientWidth &&
        p.y <= c.clientHeight
      );
    });
    const next = visible.map((e) => e.id).join('|');
    if (next === signature) return;
    signature = next;
    const host = document.querySelector('#world-overlay-actions');
    if (!host) return;
    if (!visible.length) {
      removeControls();
      return;
    }
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'world-overlay-accessibility';
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', t('Visible source records'));
      host.append(controls);
      instructions = document.createElement('span');
      instructions.id = 'well-record-navigation-instructions';
      instructions.textContent = t(
        'Use Arrow keys to move between source records, Home or End to jump, and Enter to inspect.',
      );
      host.append(instructions);
    }
    const wanted = new Set(visible.map((e) => String(e.id)));
    for (const button of [...controls.children])
      if (!wanted.has(button.dataset.recordId)) {
        if (document.activeElement === button) {
          hideFocusLabel();
          focusMap();
        }
        button.remove();
      }
    for (const entity of visible) {
      const id = String(entity.id);
      let button = [...controls.children].find(
        (b) => b.dataset.recordId === id,
      );
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.setAttribute(
          'aria-describedby',
          'well-record-navigation-instructions',
        );
        button.dataset.recordId = id;
        button.tabIndex = controls.children.length ? -1 : 0;
        button.addEventListener('keydown', (event) => {
          const list = [...controls.children],
            index = list.indexOf(button);
          const next =
            event.key === 'ArrowDown' || event.key === 'ArrowRight'
              ? (index + 1) % list.length
              : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                ? (index + list.length - 1) % list.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? list.length - 1
                    : -1;
          if (next >= 0) {
            event.preventDefault();
            list[next].focus();
          }
        });
        const current = () => source?.entities.getById(id);
        button.addEventListener('click', () => {
          const e = current();
          if (e) onSelectRecord(e);
        });
        button.addEventListener('focus', () => {
          for (const other of controls.children)
            other.tabIndex = other === button ? 0 : -1;
          revealFocusLabel(button);
          const e = current();
          if (e?.billboard) e.billboard.scale = 1.8;
          viewer.scene.requestRender?.();
        });
        button.addEventListener('blur', () => {
          hideFocusLabel();
          const e = current();
          if (e?.billboard) e.billboard.scale = 1;
          viewer.scene.requestRender?.();
        });
        controls.append(button);
      }
      button.setAttribute('aria-disabled', 'false');
      button.textContent = entity.gevWellRecordLabel || entity.name;
      if (document.activeElement === button) {
        if (entity.billboard) entity.billboard.scale = 1.8;
        revealFocusLabel(button);
      }
      if (![...controls.children].some((b) => b.tabIndex === 0))
        button.tabIndex = 0;
    }
  }
  function clear(retain = false) {
    removeFrame?.();
    removeEnd?.();
    removeFrame = removeEnd = undefined;
    if (source) source.clustering.enabled = false;
    source = undefined;
    signature = null;
    if (typeof document !== 'undefined' && !retain) removeControls();
    else if (controls)
      for (const button of controls.children)
        button.setAttribute('aria-disabled', 'true');
    overlays?.clearOverlaySource('us-groundwater-counts');
    overlays?.setOverlaySourceVisible?.('us-groundwater-counts', false);
  }
  function draw(view, owned, retainDetails = false) {
    validateCountView(view);
    clear(true);
    source = owned;
    if (!retainDetails) owned.entities.removeAll();
    owned.clustering.enabled = false;
    publish();
    removeFrame = viewer.scene.postRender?.addEventListener(publish);
    removeEnd = viewer.camera.moveEnd?.addEventListener(publish);
  }
  return {
    draw,
    clear,
    zoom: () => false,
    describeDetails: () => {},
    getStats: () => ({
      groups: 0,
      aggregateInputs: 0,
      recordCount: source?.entities.values.length ?? 0,
    }),
  };
}

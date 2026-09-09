/**
 * Manual whiteboard drawing: the Cesium + DOM half.
 *
 * DISPLAY ▸ Draw turns the globe into a whiteboard you draw on by hand: pick a
 * shape (area, line or pin), click the vertices on the real world, double-click
 * or press Enter to finish, type a label. Each finished shape goes through the
 * SAME `annotationEngine.annotate()` the voice agent uses, with its geometry
 * supplied and `manual: true`, so it renders with the whiteboard look, persists,
 * de-dups, shows up in `.list()` / GeoJSON export, and clears with the board.
 *
 * Clicks are world-anchored through the same depth-aware pick cascade the
 * resolver's screen fallback uses (`pickWorldFromScreen`), so a vertex on a
 * roof lands on the roof. While a session is open, `isDrawModeActive()` is
 * true and the tracking click gesture yields, so clicking a vertex over an
 * aircraft draws a vertex instead of tracking the plane.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from './annotationResolver.js';
import {
  DRAW_SHAPES,
  addVertex,
  canFinish,
  createDrawSession,
  drawHint,
  finishSpec,
  normalizeShape,
  removeLastVertex,
  setDrawModeActive,
} from './drawMode.js';

const COLORS = ['primary', 'amber', 'cyan', 'green', 'red'];
const PREVIEW = {
  primary: '#8be9ff', amber: '#ffb547', cyan: '#39d0ff', green: '#5dff9f', red: '#ff6b6b',
};

/**
 * Wire the Draw control. Idempotent per viewer; returns a small handle for tests
 * and the console (`window.__gevDrawTool`).
 * @param {{viewer: Cesium.Viewer, annotations: {annotate: Function}}} deps
 */
export function initDrawTool({ viewer, annotations }) {
  const toggle = document.getElementById('draw-toggle');
  const modeRow = document.getElementById('draw-mode-row');
  const labelRow = document.getElementById('draw-label-row');
  const labelInput = document.getElementById('draw-label-input');
  const colorSelect = document.getElementById('draw-color-select');
  const hint = document.getElementById('draw-hint');
  if (!viewer || !annotations || !toggle) return null;

  let active = false;
  let session = null;
  let shape = 'area';
  let color = 'primary';
  let handler = null;
  let savedDoubleClick = null;
  let cursor = null; // last mouse position on the canvas, for the rubber band
  const previewEntities = [];
  const dataSource = new Cesium.CustomDataSource('gev-draw-preview');
  viewer.dataSources.add(dataSource);

  // ---- preview ---------------------------------------------------------
  const vertexPositions = () => session.vertices.map((v) => Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height || 0));
  const previewLine = dataSource.entities.add({
    show: false,
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        if (!session) return [];
        const pts = vertexPositions();
        if (cursor && session.shape !== 'pin') pts.push(cursor);
        if (session.shape === 'area' && pts.length >= 3) pts.push(pts[0]);
        return pts;
      }, false),
      width: 3,
      material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString(PREVIEW.primary).withAlpha(0.9), dashLength: 16 }),
      depthFailMaterial: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString(PREVIEW.primary).withAlpha(0.35), dashLength: 16 }),
      clampToGround: false,
    },
  });
  const syncPreview = () => {
    previewEntities.forEach((e) => dataSource.entities.remove(e));
    previewEntities.length = 0;
    if (!session) { previewLine.show = false; return; }
    const stroke = Cesium.Color.fromCssColorString(PREVIEW[color] || PREVIEW.primary);
    previewLine.polyline.material = new Cesium.PolylineDashMaterialProperty({ color: stroke.withAlpha(0.9), dashLength: 16 });
    previewLine.show = session.shape !== 'pin';
    for (const v of session.vertices) {
      previewEntities.push(dataSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height || 0),
        point: { pixelSize: 8, color: stroke, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    }
    if (hint) hint.textContent = drawHint(session);
    viewer.scene.requestRender();
  };

  // ---- vertices from clicks --------------------------------------------
  const worldAt = (position) => {
    const canvas = viewer.scene.canvas;
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    return pickWorldFromScreen(viewer, position.x / w, position.y / h);
  };
  const onClick = (event) => {
    if (!session) return;
    const p = worldAt(event.position);
    if (!p) return;
    const { added } = addVertex(session, p);
    if (added) syncPreview();
  };
  const onMove = (event) => {
    if (!session || session.shape === 'pin') return;
    const p = worldAt(event.endPosition);
    cursor = p ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height || 0) : null;
    viewer.scene.requestRender();
  };

  // ---- finish / cancel -------------------------------------------------
  const finish = async () => {
    if (!session || !canFinish(session)) return null;
    const spec = finishSpec(session, { label: labelInput?.value || '', color });
    const finished = session;
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
    if (labelInput) labelInput.value = '';
    try {
      const result = await annotations.annotate([spec], { persist: true, flyTo: false });
      if (hint && result?.drawn === 0) hint.textContent = 'That shape could not be placed.';
      return result;
    } catch (error) {
      if (hint) hint.textContent = `Could not place the shape: ${error?.message || error}`;
      return null;
    } finally {
      void finished;
    }
  };
  const cancel = () => {
    if (!session) return;
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
  };

  // ---- keys: only while drawing, never while typing in another field ----
  const typingElsewhere = (event) => {
    const t = event.target;
    if (!t || t === labelInput) return false;
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
  };
  const onKey = (event) => {
    if (!active || typingElsewhere(event)) return;
    if (event.key === 'Enter') { if (canFinish(session)) { event.preventDefault(); void finish(); } return; }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (session?.vertices.length) cancel(); else setActive(false);
      return;
    }
    if (event.key === 'Backspace' && event.target !== labelInput) {
      if (removeLastVertex(session)) { event.preventDefault(); syncPreview(); }
    }
  };

  // ---- mode on / off -----------------------------------------------------
  function setActive(next) {
    if (next === active) return;
    active = next;
    setDrawModeActive(active);
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', String(active));
    modeRow?.classList.toggle('visible', active);
    labelRow?.classList.toggle('visible', active);
    document.body.classList.toggle('gev-drawing', active);
    if (active) {
      session = createDrawSession(shape);
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
      handler.setInputAction(() => { void finish(); }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      // The viewer's stock double-click tracks whatever entity is under the
      // pointer; while a shape is being drawn a double-click finishes it.
      const stock = viewer.screenSpaceEventHandler;
      savedDoubleClick = stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) || null;
      stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      document.addEventListener('keydown', onKey, true);
      syncPreview();
    } else {
      session = null;
      cursor = null;
      handler?.destroy();
      handler = null;
      if (savedDoubleClick) viewer.screenSpaceEventHandler.setInputAction(savedDoubleClick, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      savedDoubleClick = null;
      document.removeEventListener('keydown', onKey, true);
      syncPreview();
      if (hint) hint.textContent = drawHint(null);
    }
  }

  toggle.addEventListener('click', () => setActive(!active));
  modeRow?.querySelectorAll('.pp-mode-btn[data-shape]').forEach((btn) => {
    btn.addEventListener('click', () => {
      shape = normalizeShape(btn.dataset.shape);
      modeRow.querySelectorAll('.pp-mode-btn[data-shape]').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });
      if (active) { session = createDrawSession(shape); cursor = null; syncPreview(); }
    });
  });
  colorSelect?.addEventListener('change', () => {
    color = COLORS.includes(colorSelect.value) ? colorSelect.value : 'primary';
    syncPreview();
  });
  labelInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && canFinish(session)) { event.preventDefault(); void finish(); }
  });
  if (hint) hint.textContent = drawHint(null);

  const api = {
    get active() { return active; },
    get shape() { return shape; },
    get session() { return session; },
    setActive,
    setShape(next) { const btn = modeRow?.querySelector(`.pp-mode-btn[data-shape="${normalizeShape(next)}"]`); btn?.click(); },
    /** Test seam: add a vertex from lon/lat as if it had been clicked. */
    addVertex(lon, lat, height = 0) { if (!session) return false; const r = addVertex(session, { lon, lat, height }); if (r.added) syncPreview(); return r.added; },
    finish,
    cancel,
    shapes: DRAW_SHAPES,
  };
  window.__gevDrawTool = api;
  return api;
}

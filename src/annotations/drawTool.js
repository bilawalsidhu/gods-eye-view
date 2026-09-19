/**
 * Manual whiteboard drawing: the Cesium + DOM half.
 *
 * DISPLAY > Draw turns the globe into a whiteboard you draw on by hand: pick a
 * shape (area, line or pin), click the vertices on the real world, double-click
 * or press Enter to finish, type a label. Each finished shape goes through the
 * SAME `annotationEngine.annotate()` the voice agent uses, with its geometry
 * supplied and `manual: true`, so it renders with the whiteboard look,
 * persists, de-dups, shows up in `.list()`, and clears with the board.
 *
 * Two ownership rules make it safe to share the scene with the layers:
 *
 * - While a session is open the tool HOLDS THE POINTER
 *   (`src/data/inputOwnership.js`), and every ambient selection handler yields,
 *   so a vertex clicked on top of an aircraft or a camera is a vertex and
 *   nothing else. It is one claim consulted by all of them, not a list of
 *   exceptions inside each.
 * - Cesium's Viewer binds its OWN left click (select the entity under the
 *   pointer) and double click (track it) on the viewer's handler, outside every
 *   layer and therefore outside the shared claim. Both are borrowed for the
 *   session and given back on the way out, and `destroy()` gives back every
 *   listener, the Cesium handler, the preview data source and the window
 *   handle, so the tool can be turned off or the shell disposed without leaving
 *   anything behind.
 *
 * A vertex carries the height the click landed on — a roof, a hillside — and
 * that height is what the live preview hangs on, so the rubber band follows the
 * surface under the pointer instead of sinking to sea level. The world renderer
 * drapes finished areas and routes onto the surface, so the height is dropped
 * at finish, deliberately and in one place — see `finishSpec` in drawMode.js.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from './annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';
import {
  DRAW_SHAPES,
  MAX_VERTICES,
  addVertex,
  createDrawSession,
  drawHint,
  finishReason,
  finishSpec,
  normalizeShape,
  removeLastVertex,
} from './drawMode.js';

/** The id this tool claims the pointer under. */
export const DRAW_POINTER_OWNER = 'draw';
const PREVIEW_DATA_SOURCE_NAME = 'gev-draw-preview';

const COLORS = ['primary', 'amber', 'cyan', 'green', 'red'];
const PREVIEW = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};

/**
 * Wire the Draw control. Returns a handle with a `destroy()` the application
 * lifetime owns, plus the console/test seam (`window.__gevDrawTool`).
 * @param {{viewer: Cesium.Viewer, annotations: {annotate: Function, clear: Function}}} deps
 * @returns {{destroy: Function}|null}
 */
export function initDrawTool({ viewer, annotations }) {
  const toggle = document.getElementById('draw-toggle');
  const modeRow = document.getElementById('draw-mode-row');
  const labelRow = document.getElementById('draw-label-row');
  const labelInput = document.getElementById('draw-label-input');
  const colorSelect = document.getElementById('draw-color-select');
  const clearButton = document.getElementById('draw-clear');
  const hint = document.getElementById('draw-hint');
  if (!viewer || !annotations || !toggle) return null;

  let active = false;
  let destroyed = false;
  let session = null;
  let shape = 'area';
  let color = 'primary';
  let handler = null;
  let lease = null;
  let savedDoubleClick = null;
  let savedSingleClick = null;
  let cursor = null; // last mouse position on the canvas, for the rubber band
  // Bumped by anything that supersedes an in-flight finish: cancelling, clearing
  // the board, leaving draw mode, teardown. An `annotate()` that resolves after
  // one of those must not write its outcome over the newer state.
  let generation = 0;
  const previewEntities = [];
  // Every DOM listener this tool adds, so teardown is one loop rather than a
  // list that can fall out of step with the bindings below.
  const domListeners = [];
  const listen = (target, type, listener, options) => {
    if (!target) return;
    target.addEventListener(type, listener, options);
    domListeners.push([target, type, listener, options]);
  };

  const dataSource = new Cesium.CustomDataSource(PREVIEW_DATA_SOURCE_NAME);
  // `add()` resolves on the NEXT tick, so an init-then-immediate-destroy would
  // remove a source that had not been attached yet and leave the attachment to
  // land afterwards — a preview data source nobody owns. Chain the removal onto
  // the attachment instead of racing it.
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );

  const setHint = (text) => {
    if (hint) hint.textContent = text;
  };

  // ---- preview ---------------------------------------------------------
  const vertexPositions = () =>
    session.vertices.map((v) =>
      Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height || 0),
    );
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
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(PREVIEW.primary).withAlpha(0.9),
        dashLength: 16,
      }),
      depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString(PREVIEW.primary).withAlpha(0.35),
        dashLength: 16,
      }),
      clampToGround: false,
    },
  });
  const syncPreview = () => {
    if (destroyed) return;
    previewEntities.forEach((e) => dataSource.entities.remove(e));
    previewEntities.length = 0;
    if (!session) {
      previewLine.show = false;
      setHint(drawHint(null));
      viewer.scene.requestRender();
      return;
    }
    const stroke = Cesium.Color.fromCssColorString(
      PREVIEW[color] || PREVIEW.primary,
    );
    previewLine.polyline.material = new Cesium.PolylineDashMaterialProperty({
      color: stroke.withAlpha(0.9),
      dashLength: 16,
    });
    previewLine.show = session.shape !== 'pin';
    for (const v of session.vertices) {
      previewEntities.push(
        dataSource.entities.add({
          position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height || 0),
          point: {
            pixelSize: 8,
            color: stroke,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    setHint(drawHint(session));
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
    if (!session || destroyed) return;
    const p = worldAt(event.position);
    if (!p) return;
    const { added, reason } = addVertex(session, p);
    if (added) {
      syncPreview();
      return;
    }
    // A click that changed nothing still deserves an answer when the reason is
    // a limit rather than the harmless tail of a double-click.
    if (reason === 'full')
      setHint(
        `That shape already has ${MAX_VERTICES} points — finish it or press Backspace.`,
      );
    else if (reason === 'invalid')
      setHint('That point is off the globe — click on the world.');
  };
  const onMove = (event) => {
    if (!session || session.shape === 'pin' || destroyed) return;
    const p = worldAt(event.endPosition);
    cursor = p
      ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height || 0)
      : null;
    viewer.scene.requestRender();
  };

  // ---- finish / cancel -------------------------------------------------
  const finish = async () => {
    if (destroyed || !session) return null;
    const reason = finishReason(session);
    if (reason !== 'ok') {
      // 'too-few' is just "keep clicking" and the hint already says so;
      // a degenerate or off-globe shape needs to be told why it was refused.
      if (reason !== 'too-few') setHint(drawHint(session));
      return null;
    }
    const spec = finishSpec(session, { label: labelInput?.value || '', color });
    if (!spec) return null;
    // Start a fresh session BEFORE awaiting, so a second Enter or the second
    // half of a double-click cannot submit the same shape twice.
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
    if (labelInput) labelInput.value = '';
    const attempt = generation;
    try {
      const result = await annotations.annotate([spec], {
        persist: true,
        flyTo: false,
      });
      if (destroyed || attempt !== generation) return result;
      if (result?.drawn === 0) setHint('That shape could not be placed.');
      return result;
    } catch (error) {
      if (destroyed || attempt !== generation) return null;
      setHint(`Could not place the shape: ${error?.message || error}`);
      return null;
    }
  };
  const cancel = () => {
    if (!session) return;
    generation += 1;
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
  };
  /** Wipe the board: the shape in progress AND every mark already placed. */
  const clearAll = () => {
    generation += 1;
    cursor = null;
    if (session) session = createDrawSession(shape);
    annotations.clear();
    syncPreview();
    if (!destroyed && !active) setHint('Board cleared.');
  };

  // ---- keys: only while drawing, never while typing in another field ----
  const typingElsewhere = (event) => {
    const t = event.target;
    if (!t || t === labelInput) return false;
    return (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    );
  };
  /**
   * Enter is the finish key, but on a focused control Enter means "press this
   * control". Keyboard-focusing Clear and pressing Enter must clear the board,
   * not finish the shape — so the finish key is only taken from the canvas,
   * the page body, or the label field this tool owns.
   */
  const enterBelongsToDrawing = (event) => {
    const t = event.target;
    if (!t || t === labelInput) return true;
    if (
      typeof t.closest === 'function' &&
      t.closest('button, a, select, [role="button"], [role="radio"]')
    )
      return false;
    return (
      t === document.body || t === viewer.scene.canvas || t.tagName === 'CANVAS'
    );
  };
  const onKey = (event) => {
    if (!active || destroyed || typingElsewhere(event)) return;
    // Enter goes to finish() once a shape has been started; finish() owns the
    // decision and says WHY it refused. Swallowing the key on a degenerate
    // shape left the person pressing Enter at a silent panel. A focused button
    // keeps its own Enter — see enterBelongsToDrawing.
    if (event.key === 'Enter') {
      if (session?.vertices?.length && enterBelongsToDrawing(event)) {
        event.preventDefault();
        void finish();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (session?.vertices.length) cancel();
      else setActive(false);
      return;
    }
    if (event.key === 'Backspace' && event.target !== labelInput) {
      if (removeLastVertex(session)) {
        event.preventDefault();
        syncPreview();
      }
    }
  };

  // ---- mode on / off -----------------------------------------------------
  function setActive(next) {
    if (destroyed || next === active) return active;
    if (next) {
      lease = claimPointer(DRAW_POINTER_OWNER);
      if (!lease) {
        // Somebody else is using the pointer — possibly an older instance of
        // this same tool that has not finished tearing down. Say so instead of
        // half-starting.
        setHint(`${pointerOwner()} is using the pointer — close it first.`);
        return active;
      }
    }
    active = next;
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', String(active));
    modeRow?.classList.toggle('visible', active);
    labelRow?.classList.toggle('visible', active);
    document.body.classList.toggle('gev-drawing', active);
    if (active) {
      session = createDrawSession(shape);
      bindSceneHandler();
      syncPreview();
    } else {
      generation += 1;
      session = null;
      cursor = null;
      releaseSceneHandler();
      releasePointer(lease);
      lease = null;
      syncPreview();
    }
    return active;
  }

  function bindSceneHandler() {
    if (handler) return;
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(() => {
      void finish();
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    // Cesium's Viewer binds BOTH stock click actions on its own handler: the
    // single click picks an entity into `viewer.selectedEntity`, the double
    // click tracks it. Neither goes through a layer, so neither can be fixed by
    // the shared pointer claim — they have to be borrowed outright for the
    // session and given back on the way out. Borrowing the single click is what
    // stops a vertex placed on a contact from also selecting it.
    const stock = viewer.screenSpaceEventHandler;
    savedSingleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
    savedDoubleClick =
      stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
      null;
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    stock.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    listen(document, 'keydown', onKey, true);
  }

  function releaseSceneHandler() {
    if (handler) {
      handler.destroy();
      handler = null;
    }
    if (savedSingleClick) {
      viewer.screenSpaceEventHandler.setInputAction(
        savedSingleClick,
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      savedSingleClick = null;
    }
    if (savedDoubleClick) {
      viewer.screenSpaceEventHandler.setInputAction(
        savedDoubleClick,
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
      savedDoubleClick = null;
    }
    // Drop just the keydown listener bound alongside this handler; the control
    // listeners below outlive a session and come off in destroy().
    for (let i = domListeners.length - 1; i >= 0; i -= 1) {
      const [target, type, listener, options] = domListeners[i];
      if (listener !== onKey) continue;
      target.removeEventListener(type, listener, options);
      domListeners.splice(i, 1);
    }
  }

  listen(toggle, 'click', () => setActive(!active));
  const shapeButtons = [
    ...(modeRow?.querySelectorAll('.pp-mode-btn[data-shape]') || []),
  ];
  for (const btn of shapeButtons) {
    listen(btn, 'click', () => {
      shape = normalizeShape(btn.dataset.shape);
      for (const other of shapeButtons) {
        const on = other === btn;
        other.classList.toggle('active', on);
        other.setAttribute('aria-checked', String(on));
      }
      if (active) {
        generation += 1;
        session = createDrawSession(shape);
        cursor = null;
        syncPreview();
      }
    });
  }
  listen(colorSelect, 'change', () => {
    color = COLORS.includes(colorSelect.value) ? colorSelect.value : 'primary';
    syncPreview();
  });
  listen(clearButton, 'click', clearAll);
  listen(labelInput, 'keydown', (event) => {
    if (event.key === 'Enter' && session?.vertices?.length) {
      event.preventDefault();
      void finish();
    }
  });
  setHint(drawHint(null));

  const api = {
    get active() {
      return active;
    },
    get shape() {
      return shape;
    },
    get session() {
      return session;
    },
    setActive,
    setShape(next) {
      const btn = modeRow?.querySelector(
        `.pp-mode-btn[data-shape="${normalizeShape(next)}"]`,
      );
      btn?.click();
    },
    /** Test seam: add a vertex from lon/lat as if it had been clicked. */
    addVertex(lon, lat, height = 0) {
      if (!session) return false;
      const r = addVertex(session, { lon, lat, height });
      if (r.added) syncPreview();
      return r.added;
    },
    finish,
    cancel,
    clearAll,
    shapes: DRAW_SHAPES,
    /** What this tool currently holds — for teardown and leak assertions. */
    diagnostics() {
      return {
        active,
        destroyed,
        sceneHandler: Boolean(handler),
        domListeners: domListeners.length,
        previewDataSources: countPreviewDataSources(viewer),
        previewEntities: destroyed ? 0 : dataSource.entities.values.length,
        pointerOwner: pointerOwner(),
        // The viewer's OWN click actions. While a session is open both are
        // borrowed (absent here); after it closes both are back. A harness can
        // compare the restored functions by identity with what it captured
        // before, which is the only way to prove they were given back rather
        // than replaced.
        stockSingleClick: Boolean(
          viewer.screenSpaceEventHandler?.getInputAction?.(
            Cesium.ScreenSpaceEventType.LEFT_CLICK,
          ),
        ),
        stockDoubleClick: Boolean(
          viewer.screenSpaceEventHandler?.getInputAction?.(
            Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
          ),
        ),
      };
    },
    /** Resolves once every deferred teardown step has run. */
    whenSettled() {
      return attaching;
    },
    destroy() {
      if (destroyed) return attaching;
      // Supersede any finish still in flight before anything is torn down.
      generation += 1;
      if (active) setActive(false);
      destroyed = true;
      releaseSceneHandler();
      releasePointer(lease);
      lease = null;
      for (const [target, type, listener, options] of domListeners.splice(0)) {
        target.removeEventListener(type, listener, options);
      }
      previewEntities.length = 0;
      dataSource.entities.removeAll();
      // Wait for the pending add() before removing: a destroy() in the same
      // tick as init would otherwise remove nothing and let the attachment land
      // behind it.
      attaching = attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed — nothing to detach from */
        }
      });
      document.body.classList.remove('gev-drawing');
      toggle.classList.remove('active');
      toggle.setAttribute('aria-pressed', 'false');
      modeRow?.classList.remove('visible');
      labelRow?.classList.remove('visible');
      if (hint) hint.textContent = '';
      if (window.__gevDrawTool === api) delete window.__gevDrawTool;
      return attaching;
    },
  };
  window.__gevDrawTool = api;
  return api;
}

/** How many draw previews are attached — more than one means a leaked tool. */
function countPreviewDataSources(viewer) {
  const sources = viewer?.dataSources;
  if (!sources) return 0;
  let found = 0;
  for (let index = 0; index < sources.length; index += 1) {
    if (sources.get(index)?.name === PREVIEW_DATA_SOURCE_NAME) found += 1;
  }
  return found;
}

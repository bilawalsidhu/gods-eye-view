/**
 * Geofence UI tool: click-to-draw, edit, clear a closed geospatial polygon.
 *
 * - Draw: toggle Geofence, click vertices on the globe, double-click / Enter / Finish to close.
 * - Edit: toggle Edit, drag vertex handles to new positions.
 * - Clear: remove the geofence.
 *
 * Renders boundary (polyline) + interior fill (polygon) via geofenceRenderer.
 * Pure geometry lives in geofenceModel.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from './annotationResolver.js';
import {
  claimPointer,
  releasePointer,
  pointerOwner,
} from '../data/inputOwnership.js';
import {
  createGeofenceSession,
  addVertex,
  removeLastVertex,
  moveVertex,
  clearSession,
  canFinish,
  finishReason,
  toClosedLonLat,
  geofenceHint,
} from './geofenceModel.js';
import { createGeofenceRenderer } from './geofenceRenderer.js';

export const GEOFENCE_POINTER_OWNER = 'geofence';

export function initGeofenceTool({ viewer }) {
  const toggle = document.getElementById('geofence-toggle');
  const actionsRow = document.getElementById('geofence-actions-row');
  const finishBtn = document.getElementById('geofence-finish');
  const editBtn = document.getElementById('geofence-edit');
  const clearBtn = document.getElementById('geofence-clear');
  const hint = document.getElementById('geofence-hint');
  if (!viewer || !toggle) return null;

  let active = false; // drawing
  let editing = false;
  let destroyed = false;
  let session = createGeofenceSession();
  let geofence = null; // { vertices: [...] } closed polygon (open ring stored)
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  let cursor = null;
  let dragIndex = -1;
  let domListeners = [];
  const polygonListeners = new Set();

  const renderer = createGeofenceRenderer(viewer);

  const emitPolygonChange = () => {
    const snapshot = geofence
      ? { vertices: geofence.vertices.map((v) => ({ ...v })) }
      : null;
    for (const cb of polygonListeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.warn('[GeofenceTool] polygon listener error:', e);
      }
    }
  };

  const listen = (target, type, fn, opts) => {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    domListeners.push([target, type, fn, opts]);
  };

  const setHint = (t) => {
    if (hint) hint.textContent = t;
  };

  const syncHint = () => {
    if (destroyed) return;
    if (active) {
      setHint(geofenceHint(session, { hasGeofence: Boolean(geofence) }));
    } else if (editing) {
      setHint(
        geofence
          ? `Editing — drag a handle to move it. ${geofence.vertices.length} points. Done to finish.`
          : 'No geofence to edit.',
      );
    } else if (geofence) {
      setHint(
        `Geofence closed — ${geofence.vertices.length} points. Edit to adjust, Clear to remove.`,
      );
    } else {
      setHint('Press Geofence, then click the globe to draw.');
    }
  };

  const webhookRow = document.getElementById('geofence-webhook-row');
  const testRow = document.getElementById('geofence-test-row');

  const syncUI = () => {
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', String(active));
    editBtn?.classList.toggle('active', editing);
    editBtn?.setAttribute('aria-pressed', String(editing));
    const show = active || editing || Boolean(geofence);
    actionsRow?.classList.toggle('visible', show);
    webhookRow?.classList.toggle('visible', show);
    testRow?.classList.toggle('visible', show);
    document.body.classList.toggle('gev-geofencing', active || editing);
    if (finishBtn) finishBtn.disabled = !active;
    if (editBtn) editBtn.disabled = !geofence;
    if (clearBtn)
      clearBtn.disabled = !geofence && session.vertices.length === 0;
    syncHint();
  };

  const worldAt = (position) => {
    const canvas = viewer.scene.canvas;
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    return pickWorldFromScreen(viewer, position.x / w, position.y / h);
  };

  const updateDraft = () => {
    if (destroyed) return;
    if (!active) return;
    renderer.setDraft(session.vertices, cursor);
    syncUI();
    viewer.scene.requestRender();
  };

  const ensurePointer = () => {
    if (lease) return true;
    lease = claimPointer(GEOFENCE_POINTER_OWNER);
    if (!lease) {
      setHint(`${pointerOwner()} is using the pointer — close it first.`);
      return false;
    }
    return true;
  };

  const maybeReleasePointer = () => {
    if (!active && !editing && lease) {
      releasePointer(lease);
      lease = null;
    }
  };

  function bindHandler() {
    if (handler) return;
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(onMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(
      onDoubleClick,
      Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    handler.setInputAction(onDown, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(onUp, Cesium.ScreenSpaceEventType.LEFT_UP);

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

  function releaseHandler() {
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
    for (let i = domListeners.length - 1; i >= 0; i -= 1) {
      const [t, ty, fn, op] = domListeners[i];
      if (fn !== onKey) continue;
      t.removeEventListener(ty, fn, op);
      domListeners.splice(i, 1);
    }
  }

  function setActive(next) {
    if (destroyed || next === active) return active;
    if (next) {
      if (!ensurePointer()) return active;
      active = true;
      // starting a new draw keeps existing geofence until finished
      session = createGeofenceSession();
      cursor = null;
      // if we were editing, leave edit mode
      if (editing) setEditing(false, { keepLease: true });
      bindHandler();
      renderer.setDraft([], null);
    } else {
      active = false;
      cursor = null;
      dragIndex = -1;
      if (!editing) {
        releaseHandler();
        maybeReleasePointer();
      }
      // clear draft preview but keep finished geofence
      if (geofence) {
        renderer.setDraft([], null);
        // re-show geofence (setDraft hid it in earlier impl — now we restore)
        renderer.setGeofence(toClosedLonLat({ vertices: geofence.vertices }));
        if (editing) renderer.setEditHandles(geofence.vertices);
      } else {
        renderer.setDraft([], null);
      }
    }
    syncUI();
    viewer.scene.requestRender();
    return active;
  }

  function setEditing(next, { keepLease = false } = {}) {
    if (destroyed || next === editing) return editing;
    if (next) {
      if (!geofence) {
        setHint('Draw a geofence first.');
        return editing;
      }
      if (!ensurePointer()) return editing;
      editing = true;
      if (active) {
        // leave drawing but keep handler/lease
        active = false;
        cursor = null;
      }
      bindHandler();
      renderer.setEditHandles(geofence.vertices);
    } else {
      editing = false;
      dragIndex = -1;
      // hide handles, keep fill/boundary
      if (geofence) {
        renderer.setGeofence(toClosedLonLat({ vertices: geofence.vertices }));
      }
      if (!active && !keepLease) {
        releaseHandler();
        maybeReleasePointer();
      }
    }
    syncUI();
    viewer.scene.requestRender();
    return editing;
  }

  function finish() {
    if (destroyed || !active) return false;
    const reason = finishReason(session);
    if (reason !== 'ok') {
      syncHint();
      return false;
    }
    const ring = toClosedLonLat(session);
    geofence = { vertices: session.vertices.map((v) => ({ ...v })) };
    renderer.setGeofence(ring);
    // reset draft
    session = createGeofenceSession();
    cursor = null;
    setActive(false);
    // ensure edit button enabled
    syncUI();
    emitPolygonChange();
    return true;
  }

  function clearAll() {
    if (destroyed) return;
    const had = Boolean(geofence);
    geofence = null;
    clearSession(session);
    cursor = null;
    dragIndex = -1;
    renderer.clear();
    if (editing) setEditing(false, { keepLease: false });
    if (active) {
      // stay in draw mode but with empty draft
      renderer.setDraft([], null);
    }
    syncUI();
    viewer.scene.requestRender();
    if (had) emitPolygonChange();
  }

  // ---- events ----
  function onClick(event) {
    if (destroyed) return;
    if (editing) return; // edit uses drag, not click-add
    if (!active) return;
    const p = worldAt(event.position);
    if (!p) {
      setHint('That point is off the globe — click on the world.');
      return;
    }
    const { added, reason } = addVertex(session, p);
    if (added) {
      updateDraft();
      return;
    }
    if (reason === 'full')
      setHint('512-point limit reached — finish or press Backspace.');
    else if (reason === 'invalid')
      setHint('That point is off the globe — click on the world.');
  }

  function onMove(event) {
    if (destroyed) return;
    if (dragIndex >= 0 && editing && geofence) {
      const p = worldAt(event.endPosition);
      if (!p) return;
      // live move
      geofence.vertices[dragIndex] = { lon: p.lon, lat: p.lat };
      renderer.setGeofence(toClosedLonLat({ vertices: geofence.vertices }));
      renderer.setEditHandles(geofence.vertices);
      // keep dragIndex valid after re-render (handles recreated)
      viewer.scene.requestRender();
      return;
    }
    if (!active) return;
    const p = worldAt(event.endPosition);
    cursor = p ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0) : null;
    renderer.setDraft(session.vertices, cursor);
    viewer.scene.requestRender();
  }

  function onDoubleClick() {
    if (destroyed) return;
    if (active) finish();
  }

  function onDown(event) {
    if (destroyed || !editing || !geofence) return;
    const p = worldAt(event.position);
    if (!p) return;
    // find nearest vertex within tolerance (screen-space approx via world distance)
    // tolerance scales with camera height: ~2% of height, min 50m, max 5000m
    const h = viewer.camera.positionCartographic?.height ?? 10000;
    const tol = Math.max(50, Math.min(5000, h * 0.02));
    let best = -1;
    let bestD = Infinity;
    geofence.vertices.forEach((v, idx) => {
      // quick lon/lat distance via great-circle
      const d = Math.hypot(
        (v.lon - p.lon) * 111320 * Math.cos((v.lat * Math.PI) / 180),
        (v.lat - p.lat) * 111320,
      );
      // also consider using imported greatCircle if needed, but planar is fine for tolerance
      if (d < tol && d < bestD) {
        bestD = d;
        best = idx;
      }
    });
    // fallback: try scene.pick for handle entity
    if (best === -1) {
      try {
        const picked = viewer.scene.pick(event.position);
        const idx = picked?.id?._geofenceVertexIndex;
        if (Number.isInteger(idx) && idx >= 0 && idx < geofence.vertices.length)
          best = idx;
      } catch {}
    }
    if (best >= 0) {
      dragIndex = best;
      // prevent camera rotation while dragging
      viewer.scene.screenSpaceCameraController.enableRotate = false;
      viewer.scene.screenSpaceCameraController.enableTranslate = false;
    }
  }

  function onUp() {
    if (dragIndex >= 0) {
      dragIndex = -1;
      viewer.scene.screenSpaceCameraController.enableRotate = true;
      viewer.scene.screenSpaceCameraController.enableTranslate = true;
      // re-render handles at final positions
      if (editing && geofence) {
        renderer.setGeofence(toClosedLonLat({ vertices: geofence.vertices }));
        renderer.setEditHandles(geofence.vertices);
        emitPolygonChange();
      }
      syncUI();
    }
  }

  function onKey(event) {
    if (destroyed) return;
    const typing =
      event.target &&
      event.target !== document.body &&
      (event.target.tagName === 'INPUT' ||
        event.target.tagName === 'TEXTAREA' ||
        event.target.isContentEditable);
    if (typing) return;
    if (!active && !editing) return;
    if (event.key === 'Enter') {
      if (active && session.vertices.length) {
        // avoid triggering when focus on button
        const t = event.target;
        const onControl = t?.closest?.('button, select, a, [role="button"]');
        if (!onControl) {
          event.preventDefault();
          finish();
        }
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (active && session.vertices.length) {
        clearSession(session);
        cursor = null;
        renderer.setDraft([], null);
        syncUI();
      } else if (editing) {
        setEditing(false);
      } else if (active) {
        setActive(false);
      }
    } else if (event.key === 'Backspace') {
      if (active && removeLastVertex(session)) {
        event.preventDefault();
        updateDraft();
      }
    }
  }

  // ---- DOM wiring ----
  listen(toggle, 'click', () => {
    if (editing) setEditing(false);
    setActive(!active);
  });
  listen(finishBtn, 'click', () => finish());
  listen(editBtn, 'click', () => setEditing(!editing));
  listen(clearBtn, 'click', clearAll);

  syncUI();

  const api = {
    get active() {
      return active;
    },
    get editing() {
      return editing;
    },
    get geofence() {
      return geofence
        ? { vertices: geofence.vertices.map((v) => ({ ...v })) }
        : null;
    },
    get session() {
      return session;
    },
    setActive,
    setEditing,
    finish,
    clear: clearAll,
    // test seams
    addVertex(lon, lat) {
      if (!active) return false;
      const r = addVertex(session, { lon, lat });
      if (r.added) updateDraft();
      return r.added;
    },
    moveVertex(index, lon, lat) {
      if (!geofence) return false;
      const ok = moveVertex(geofence, index, { lon, lat });
      if (ok) {
        renderer.setGeofence(toClosedLonLat({ vertices: geofence.vertices }));
        if (editing) renderer.setEditHandles(geofence.vertices);
        syncUI();
        emitPolygonChange();
      }
      return ok;
    },
    onPolygonChange(cb) {
      if (typeof cb !== 'function') return () => {};
      polygonListeners.add(cb);
      return () => polygonListeners.delete(cb);
    },
    getGeoJSON(props = {}) {
      if (!geofence) return null;
      const closed = toClosedLonLat({ vertices: geofence.vertices });
      if (closed.length < 4) return null;
      return {
        type: 'Feature',
        properties: { ...props, kind: 'geofence' },
        geometry: { type: 'Polygon', coordinates: [closed] },
      };
    },
    diagnostics() {
      return {
        active,
        editing,
        destroyed,
        hasGeofence: Boolean(geofence),
        vertices: geofence?.vertices.length ?? session.vertices.length,
        pointerOwner: pointerOwner(),
        ...renderer.diagnostics(),
      };
    },
    destroy() {
      if (destroyed) return renderer.whenSettled();
      destroyed = true;
      if (active || editing) {
        active = false;
        editing = false;
        releaseHandler();
        if (lease) {
          releasePointer(lease);
          lease = null;
        }
      } else {
        releaseHandler();
      }
      for (const [t, ty, fn, op] of domListeners.splice(0)) {
        t.removeEventListener(ty, fn, op);
      }
      document.body.classList.remove('gev-geofencing');
      toggle.classList.remove('active');
      toggle.setAttribute('aria-pressed', 'false');
      actionsRow?.classList.remove('visible');
      if (hint) hint.textContent = '';
      renderer.destroy();
      if (typeof window !== 'undefined' && window.__gevGeofence === api)
        delete window.__gevGeofence;
      return renderer.whenSettled();
    },
  };

  // expose for console / tests
  if (typeof window !== 'undefined') window.__gevGeofence = api;

  return api;
}

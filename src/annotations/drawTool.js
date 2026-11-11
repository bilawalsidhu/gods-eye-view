/**
 * Manual whiteboard drawing through the globe engine and DOM.
 *
 * UTILITIES ▸ Draw turns the globe into a whiteboard you draw on by hand: pick a
 * shape (area, line or pin) and a colour, click the vertices on the real world,
 * double-click or press Enter to finish, then name, recolour, hide, fly to or
 * remove the shape from its row (drawMarks.js). Each finished shape goes through the
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
 * - The engine's exclusive pointer suspends other screen subscriptions and
 *   stock select/track actions until drawing ends.
 *
 * A vertex carries the height the click landed on — a roof, a hillside — and
 * that height is what the live preview hangs on, so the rubber band follows the
 * surface under the pointer instead of sinking to sea level. The world renderer
 * drapes finished areas and routes onto the surface, so the height is dropped
 * at finish, deliberately and in one place — see `finishSpec` in drawMode.js.
 */
import { createDrawSurface } from './drawSurface.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';
import { pointerOwnerName } from '../data/pointerOwnerNames.js';
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

import {
  DRAW_COLORS,
  drawMarkActions,
  drawMarkActionsFor,
  drawMarkFallbackName,
  presentDrawMarks,
} from './drawMarks.js';

import { onLocaleChange, t, translateKnown } from '../i18n/index.js';
/** The longest note a row action leaves under its row, in characters. */
const NOTE_MAX = 200;
/** An action's answer as a row note: trimmed, and cut at a word with an ellipsis. */
function noteText(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= NOTE_MAX) return trimmed;
  const cut = trimmed.slice(0, NOTE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > NOTE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The id this tool claims the pointer under. */
const DRAW_POINTER_OWNER = 'draw';

/**
 * Run the Draw control. Returns a handle with a `destroy()` the application
 * lifetime owns, plus the console/test seam (`window.__gevDrawTool`).
 * The tool hands what the controls show (`{ active, shape, color, hint,
 * marks }`) to `publish`, which the view renders, and answers the controls
 * through the actions it gives `connect`, which returns their disconnect.
 * A row's fly-to is an immediate navigation through `navigation`, like
 * Import's, so Cockpit can refuse it and a running orbit or follow lets go.
 * Input and preview use the attached globe engine.
 * `markActions` are the application's own buttons on an area's or a line's
 * row (drawMarks.js `drawMarkActions`); a press runs the action with the
 * shape's id, kind, name and geometry (drawMarks.js `drawMarkGeometry`).
 * @param {{engine: object, annotations: {annotate: Function, clear: Function}, navigation?: object, publish?: Function, connect?: Function, markActions?: object[]}} deps
 * @returns {{destroy: Function}|null}
 */
export function initDrawTool({
  engine = null,
  annotations,
  navigation = null,
  publish = () => {},
  connect = () => () => {},
  initialShape = 'area',
  initialColor = 'primary',
  markActions = [],
}) {
  const rowActions = drawMarkActions(markActions);
  // What a row action said last on each drawn shape: `{ run, busy, text }`.
  const notes = new Map();
  let noteRun = 0;
  // A page without the Draw controls (the Display controls view omitted) has
  // no draw tool.
  if (!engine || !annotations || !document.getElementById('draw-toggle'))
    return null;

  let active = false;
  let destroyed = false;
  let session = null;
  let shape = normalizeShape(initialShape);
  let color = DRAW_COLORS.includes(initialColor) ? initialColor : 'primary';
  let hint = '';
  let lease = null;
  let pointer = null;
  // The last pointer position on the globe ({ lon, lat, height }), for the
  // rubber band.
  let cursor = null;
  // Bumped by anything that supersedes an in-flight finish: cancelling, clearing
  // the board, leaving draw mode, teardown. An `annotate()` that resolves after
  // one of those must not write its outcome over the newer state.
  let generation = 0;
  // Every DOM listener this tool adds (the session's keydown), so teardown is
  // one loop rather than a list that can fall out of step with the bindings.
  const domListeners = [];
  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    domListeners.push([target, type, listener, options]);
  };

  const live = { session: () => session, cursor: () => cursor };
  const surface = createDrawSurface(engine)(live);

  const present = () => {
    const marks = annotations.list?.() || [];
    // A note goes with its shape.
    for (const id of notes.keys())
      if (!marks.some((mark) => mark.id === id)) notes.delete(id);
    publish({
      active,
      shape,
      color,
      hint,
      marks: presentDrawMarks(marks, rowActions, notes),
    });
  };
  // The hint is kept as the call that words it, so a language switch can
  // word it again.
  let hintText = () => '';
  const setHint = (text) => {
    hintText = text;
    hint = text();
    present();
  };
  const offLocale = onLocaleChange(() => {
    if (!destroyed) setHint(hintText);
  });

  // ---- preview ---------------------------------------------------------
  const syncPreview = () => {
    if (destroyed) return;
    surface.sync(session, color);
    setHint(() => drawHint(session));
  };

  // ---- vertices from clicks --------------------------------------------
  const worldAt = (position) => surface.pick(position);
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
      setHint(() =>
        t(
          'That shape already has {count} points — finish it or press Backspace.',
          { count: MAX_VERTICES },
        ),
      );
    else if (reason === 'invalid')
      setHint(() => t('That point is off the globe — click on the world.'));
  };
  const onMove = (event) => {
    if (!session || session.shape === 'pin' || destroyed) return;
    const p = worldAt(event.endPosition);
    cursor = p ? { lon: p.lon, lat: p.lat, height: p.height || 0 } : null;
    surface.moved();
  };

  // ---- finish / cancel -------------------------------------------------
  const finish = async () => {
    if (destroyed || !session) return null;
    const reason = finishReason(session);
    if (reason !== 'ok') {
      // 'too-few' is just "keep clicking" and the hint already says so;
      // a degenerate or off-globe shape needs to be told why it was refused.
      if (reason !== 'too-few') setHint(() => drawHint(session));
      return null;
    }
    // Named afterwards, in the shape's row.
    const spec = finishSpec(session, { label: '', color });
    if (!spec) return null;
    // Start a fresh session BEFORE awaiting, so a second Enter or the second
    // half of a double-click cannot submit the same shape twice.
    session = createDrawSession(shape);
    cursor = null;
    syncPreview();
    const attempt = generation;
    try {
      const result = await annotations.annotate([spec], {
        persist: true,
        flyTo: false,
      });
      if (destroyed || attempt !== generation) return result;
      if (result?.drawn === 0)
        setHint(() => t('That shape could not be placed.'));
      return result;
    } catch (error) {
      if (destroyed || attempt !== generation) return null;
      setHint(() =>
        t('Could not place the shape: {error}', {
          error: error?.message || error,
        }),
      );
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
    if (!destroyed && !active) setHint(() => t('Board cleared.'));
  };

  // ---- keys: only while drawing, never while typing in another field ----
  const typingElsewhere = (event) => {
    const t = event.target;
    if (!t) return false;
    return (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    );
  };
  /**
   * Enter is the finish key, but on a focused control Enter means "press this
   * control". Keyboard-focusing Clear and pressing Enter must clear the board,
   * not finish the shape — so the finish key is only taken from the canvas or
   * the page body.
   */
  const enterBelongsToDrawing = (event) => {
    const t = event.target;
    if (!t) return true;
    if (
      typeof t.closest === 'function' &&
      t.closest('button, a, select, [role="button"], [role="radio"]')
    )
      return false;
    return (
      t === document.body || t === surface.canvas || t.tagName === 'CANVAS'
    );
  };
  const onKey = (event) => {
    if (!active || destroyed || typingElsewhere(event)) return;
    // Keys on the shape list's own controls are the list's (Esc closes a
    // colour picker there), not the drawing's.
    if (event.target?.closest?.('#draw-mark-list')) return;
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
    if (event.key === 'Backspace') {
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
      if (lease) pointer = engine.input.acquirePointer();
      if (!lease || !pointer) {
        releasePointer(lease);
        lease = null;
        // Somebody else is using the pointer — possibly an older instance of
        // this same tool that has not finished tearing down. Say so instead of
        // half-starting.
        setHint(() =>
          t('{owner} is using the pointer — close it first.', {
            owner: translateKnown(pointerOwnerName(pointerOwner())),
          }),
        );
        return active;
      }
    }
    active = next;
    present();
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
      pointer?.release();
      pointer = null;
      releasePointer(lease);
      lease = null;
      syncPreview();
    }
    return active;
  }

  function bindSceneHandler() {
    if (surface.bound()) return;
    surface.bind(
      {
        click: onClick,
        move: onMove,
        doubleClick: () => {
          void finish();
        },
      },
      pointer,
    );
    listen(document, 'keydown', onKey, true);
  }

  function releaseSceneHandler() {
    surface.unbind();
    // Drop the keydown listener bound alongside this handler.
    for (let i = domListeners.length - 1; i >= 0; i -= 1) {
      const [target, type, listener, options] = domListeners[i];
      if (listener !== onKey) continue;
      target.removeEventListener(type, listener, options);
      domListeners.splice(i, 1);
    }
  }

  /**
   * Frame one drawn shape: an immediate navigation, so Cockpit can refuse it
   * and the current orbit, follow or track lets go first.
   */
  function flyToMark(id) {
    if (typeof navigation?.runImmediateNavigation === 'function')
      return (
        navigation.runImmediateNavigation('drawing', () =>
          annotations.frame?.(id),
        ) !== false
      );
    return annotations.frame?.(id) ?? false;
  }

  /**
   * Run the application's row action `actionId` on drawn shape `id`, if the
   * shape is still on the board and still offered it. Returns whether it ran.
   * What the action returns, or resolves to, is the row's note (a measurement,
   * "saved"): the row is busy until it settles, a newer press or the shape's
   * removal makes a late answer moot, and a failure clears the note, so an
   * action words its own refusals and resolves with them.
   */
  function runMarkAction(id, actionId) {
    const mark = (annotations.list?.() || []).find(
      (entry) => entry.id === id && entry.manual === true,
    );
    const offer = drawMarkActionsFor(mark, rowActions);
    const action = offer.actions.find((entry) => entry.id === actionId);
    if (!action || notes.get(mark.id)?.busy) return false;
    const run = ++noteRun;
    const settle = (text) => {
      if (destroyed || notes.get(mark.id)?.run !== run) return;
      notes.set(mark.id, {
        run,
        busy: false,
        text: noteText(text),
      });
      present();
    };
    const fail = (error) => {
      console.warn(`[draw] ${actionId} failed`, error);
      settle('');
    };
    notes.set(mark.id, { run, busy: true, text: '' });
    let answer;
    try {
      answer = action.run({
        id: mark.id,
        shape: offer.shape,
        name: mark.name || '',
        title: mark.name || drawMarkFallbackName(mark),
        geometry: offer.geometry,
      });
    } catch (error) {
      fail(error);
      return false;
    }
    if (typeof answer?.then === 'function') {
      present();
      Promise.resolve(answer).then(settle, fail);
    } else settle(answer);
    return true;
  }

  /** Draw `next` from now on; an open shape starts over in it. */
  function chooseShape(next) {
    shape = normalizeShape(next);
    present();
    if (active) {
      generation += 1;
      session = createDrawSession(shape);
      cursor = null;
      syncPreview();
    }
  }
  const disconnect = connect({
    toggleDraw: () => setActive(!active),
    setDrawShape: chooseShape,
    setDrawColor: (value) => {
      color = DRAW_COLORS.includes(value) ? value : 'primary';
      present();
      syncPreview();
    },
    clearDraw: clearAll,
    renameDrawMark: (id, name) => annotations.restyle?.(id, { name }),
    recolorDrawMark: (id, next) => annotations.restyle?.(id, { color: next }),
    toggleDrawMark: (id) => {
      const mark = annotations.list?.().find((entry) => entry.id === id);
      if (mark) annotations.setHidden?.(id, !mark.hidden);
    },
    flyToDrawMark: flyToMark,
    removeDrawMark: (id) => annotations.remove?.(id),
    runDrawMarkAction: runMarkAction,
  });
  // The rows follow the board: a shape drawn, renamed, hidden or removed
  // here, by voice or by a clear.
  const offBoard =
    annotations.onChange?.(() => {
      if (!destroyed) present();
    }) || (() => {});
  setHint(() => drawHint(null));

  const api = {
    get active() {
      return active;
    },
    get shape() {
      return shape;
    },
    get color() {
      return color;
    },
    get session() {
      return session;
    },
    setActive,
    setShape: chooseShape,
    /** The hand-drawn marks the list shows, as its rows. */
    marks: () =>
      presentDrawMarks(annotations.list?.() || [], rowActions, notes),
    setColor(next) {
      color = DRAW_COLORS.includes(next) ? next : 'primary';
      present();
      syncPreview();
    },
    flyToMark,
    runMarkAction,
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
        domListeners: domListeners.length,
        pointerOwner: pointerOwner(),
        // The globe's input and preview.
        ...surface.diagnostics({ destroyed }),
      };
    },
    /** Resolves once every deferred teardown step has run. */
    whenSettled() {
      return surface.settled();
    },
    destroy() {
      if (destroyed) return surface.settled();
      // Supersede any finish still in flight before anything is torn down.
      generation += 1;
      if (active) setActive(false);
      destroyed = true;
      offLocale();
      offBoard();
      disconnect();
      releaseSceneHandler();
      pointer?.release();
      pointer = null;
      releasePointer(lease);
      lease = null;
      for (const [target, type, listener, options] of domListeners.splice(0)) {
        target.removeEventListener(type, listener, options);
      }
      // The preview leaves once the globe's pending attachment has landed.
      const settled = surface.destroy();
      document.body.classList.remove('gev-drawing');
      hint = '';
      present();
      if (window.__gevDrawTool === api) delete window.__gevDrawTool;
      return settled;
    },
  };
  window.__gevDrawTool = api;
  return api;
}

/**
 * The Draw control for the page session. The marks live on the annotation
 * board and the chosen shape and colour here; the drawing tool itself (its
 * preview, click handler and Escape/Enter keys) belongs to the attached
 * globe. `attachScene({ engine, navigation })` starts the tool with the shape
 * and colour last chosen; `detachScene()` ends the open shape. Without a
 * globe the controls answer nothing. Same handle as initDrawTool's
 * (`window.__gevDrawTool`), kept across switches.
 */
export function createSessionDrawTool({
  annotations,
  navigation = null,
  publish = () => {},
  connect = () => () => {},
  markActions = [],
}) {
  if (!annotations || !document.getElementById('draw-toggle')) return null;
  let inner = null;
  let shape = 'area';
  let color = 'primary';
  let destroyed = false;
  let settled = Promise.resolve();
  const detachScene = () => {
    if (!inner) return settled;
    shape = inner.shape;
    color = inner.color;
    const previous = inner;
    inner = null;
    settled = previous.destroy();
    if (window.__gevDrawTool === previous) window.__gevDrawTool = wrapper;
    return settled;
  };
  const wrapper = {
    get active() {
      return inner?.active ?? false;
    },
    get shape() {
      return inner?.shape ?? shape;
    },
    get color() {
      return inner?.color ?? color;
    },
    get session() {
      return inner?.session ?? null;
    },
    get attached() {
      return Boolean(inner);
    },
    setActive: (next) => inner?.setActive(next) ?? false,
    setShape(next) {
      shape = normalizeShape(next);
      inner?.setShape(next);
    },
    setColor(next) {
      color = DRAW_COLORS.includes(next) ? next : 'primary';
      inner?.setColor(next);
    },
    marks: () =>
      inner?.marks() ??
      presentDrawMarks(
        annotations.list?.() || [],
        drawMarkActions(markActions),
      ),
    flyToMark: (id) => inner?.flyToMark(id) ?? false,
    runMarkAction: (id, actionId) =>
      inner?.runMarkAction(id, actionId) ?? false,
    addVertex: (...args) => inner?.addVertex(...args) ?? false,
    finish: () => inner?.finish() ?? Promise.resolve(null),
    cancel: () => inner?.cancel(),
    clearAll: () => (inner ? inner.clearAll() : annotations.clear?.()),
    shapes: DRAW_SHAPES,
    diagnostics: () =>
      inner?.diagnostics() ?? {
        active: false,
        destroyed,
        sceneHandler: false,
        domListeners: 0,
        previewDataSources: 0,
        previewEntities: 0,
        pointerOwner: pointerOwner(),
      },
    whenSettled: () => inner?.whenSettled() ?? settled,
    attachScene({ engine = null, navigation: next = navigation } = {}) {
      if (destroyed) return;
      detachScene();
      navigation = next;
      if (!engine) return;
      inner = initDrawTool({
        engine,
        annotations,
        navigation,
        publish,
        connect,
        markActions,
        initialShape: shape,
        initialColor: color,
      });
      window.__gevDrawTool = wrapper;
    },
    detachScene,
    destroy() {
      if (destroyed) return settled;
      const done = detachScene();
      destroyed = true;
      if (window.__gevDrawTool === wrapper) delete window.__gevDrawTool;
      return done;
    },
  };
  window.__gevDrawTool = wrapper;
  return wrapper;
}

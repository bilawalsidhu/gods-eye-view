import * as Cesium from 'cesium';
import { t, translateKnown } from '../../i18n/index.js';
import { pointerOwnerName } from '../../data/pointerOwnerNames.js';
import {
  DEFAULT_ALT_FT,
  addAircraft,
  appendWaypoint,
  clearWaypoints,
  cloneDocument,
  documentSummary,
  emptyDocument,
  parseDocument,
  playableDocument,
  removeAircraft,
  removeLastWaypoint,
  serializeDocument,
  setAircraftLoop,
  waypointDefaults,
  withCameras,
} from './document.js';

export const EDITOR_LAYER_ID = 'scenario-editor';
export const EDITOR_LAYER_NAME = 'Scenario Editor';
/** Pointer-ownership id while the editor places waypoints. */
export const EDITOR_POINTER_OWNER = 'scenario-editor';
export const ALT_FT_LIMITS = Object.freeze([0, 20_000]);
export const ALT_FT_STEP = 100;

const MODES = Object.freeze(['off', 'add']);
const ACTIONS = Object.freeze({
  NEW: 'new-aircraft',
  UNDO: 'undo-waypoint',
  CLEAR: 'clear-path',
  LOOP: 'toggle-loop',
  REMOVE: 'remove-aircraft',
  EXPORT: 'export-json',
  IMPORT: 'import-json',
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The Scenario Editor layer: build or change a scenario in place. With
 * **Add waypoints** on, each left click on the globe appends a waypoint
 * (at the row's altitude, the previous waypoint's speed) to the selected
 * aircraft, and the Simulation layer flies the edited document at once. The
 * editor takes the pointer through the shared input ownership while adding,
 * so ambient selection handlers stay out of its way, and releases it when
 * the mode goes off. Export writes the file (with any session cameras);
 * Import reads one.
 *
 * @param {object} options
 * @param {object} options.simulation Simulation layer (`getDocument`, `replaceScenario`, `subscribe`).
 * @param {object|null} [options.cameras] Virtual Cameras layer, for `getSessionCameras()` on export.
 * @param {object} [options.services]
 * @param {{claimPointer:Function, releasePointer:Function, pointerOwner:Function}|null} [options.services.input]
 * @param {(name:string, text:string)=>void} [options.download] File writer.
 * @param {() => Promise<string>} [options.pickFile] File reader.
 * @param {typeof Cesium} [options.cesium]
 * @param {(canvas:HTMLCanvasElement)=>object} [options.createInputHandler]
 */
export function createScenarioEditorLayer({
  simulation,
  cameras = null,
  services = {},
  download = null,
  pickFile = null,
  cesium = Cesium,
  createInputHandler = (canvas) => new cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  if (!simulation?.replaceScenario)
    throw new TypeError('The scenario editor needs the Simulation layer');
  const input = services.input || null;

  let viewer = null;
  let enabled = false;
  let draft = emptyDocument();
  let selectedId = null;
  let mode = 'off';
  let altFt = DEFAULT_ALT_FT;
  let dirty = false;
  let lease = null;
  let handler = null;
  let error = null;
  let busyOwner = null;
  let unsubscribe = null;
  let rowControlsListener = null;

  function notify() {
    rowControlsListener?.();
  }

  function selected() {
    return draft.aircraft.find((entry) => entry.id === selectedId) || null;
  }

  function adoptDocument(doc) {
    draft = doc ? cloneDocument(doc) : emptyDocument();
    if (!Array.isArray(draft.cameras)) draft.cameras = [];
    if (!draft.aircraft.some((entry) => entry.id === selectedId))
      selectedId = draft.aircraft[0]?.id || null;
    if (selectedId) altFt = waypointDefaults(draft, selectedId).altFt;
  }

  /** Hand the playable part of the draft to the Simulation layer. */
  function pushLive() {
    const playable = playableDocument(draft);
    if (playable.aircraft.length === 0) return true;
    const result = simulation.replaceScenario(playable, { keepTime: true });
    if (result && result.ok === false) {
      error = result.error;
      return false;
    }
    error = null;
    return true;
  }

  function clickPosition(windowPosition) {
    const scene = viewer?.scene;
    if (!scene) return null;
    let cartesian = null;
    try {
      if (
        scene.pickPositionSupported &&
        typeof scene.pickPosition === 'function'
      )
        cartesian = scene.pickPosition(windowPosition) || null;
    } catch {
      cartesian = null;
    }
    if (!cartesian) {
      try {
        cartesian =
          scene.camera?.pickEllipsoid?.(
            windowPosition,
            scene.globe?.ellipsoid,
          ) || null;
      } catch {
        cartesian = null;
      }
    }
    if (!cartesian) return null;
    const carto = cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: cesium.Math.toDegrees(carto.latitude),
      lon: cesium.Math.toDegrees(carto.longitude),
    };
  }

  function onClick(windowPosition) {
    if (mode !== 'add' || !selectedId) return;
    const where = clickPosition(windowPosition);
    if (!where) return;
    try {
      draft = appendWaypoint(draft, selectedId, { ...where, altFt });
    } catch (failure) {
      error = failure?.message || String(failure);
      notify();
      return;
    }
    dirty = true;
    pushLive();
    notify();
  }

  function startAdding() {
    if (mode === 'add') return true;
    if (!selectedId) {
      const created = addAircraft(draft);
      draft = created.doc;
      selectedId = created.id;
      dirty = true;
    }
    const nextLease = input?.claimPointer
      ? input.claimPointer(EDITOR_POINTER_OWNER)
      : {};
    if (!nextLease) {
      busyOwner = input?.pointerOwner?.() || 'unknown';
      notify();
      return false;
    }
    busyOwner = null;
    lease = nextLease;
    const canvas = viewer?.scene?.canvas;
    if (canvas && !handler) {
      handler = createInputHandler(canvas);
      handler.setInputAction?.(
        (click) => onClick(click?.position),
        cesium.ScreenSpaceEventType?.LEFT_CLICK ?? 'LEFT_CLICK',
      );
    }
    mode = 'add';
    notify();
    return true;
  }

  function stopAdding() {
    if (handler) {
      handler.destroy?.();
      handler = null;
    }
    if (lease && input?.releasePointer) input.releasePointer(lease);
    lease = null;
    mode = 'off';
    notify();
  }

  function exportDocument() {
    const session = cameras?.getSessionCameras?.() || [];
    const text = serializeDocument(withCameras(draft, session));
    if (typeof download === 'function') download(`${draft.id}.json`, text);
    dirty = false;
    notify();
    return text;
  }

  async function importDocument() {
    if (typeof pickFile !== 'function') return false;
    let text;
    try {
      text = await pickFile();
    } catch (failure) {
      error = failure?.message || String(failure);
      notify();
      return false;
    }
    const parsed = parseDocument(text);
    if (!parsed.ok) {
      error = parsed.error;
      notify();
      return false;
    }
    error = null;
    adoptDocument(parsed.doc);
    dirty = true;
    pushLive();
    notify();
    return true;
  }

  function runAction(action) {
    switch (action) {
      case ACTIONS.NEW: {
        const created = addAircraft(draft);
        draft = created.doc;
        selectedId = created.id;
        altFt = DEFAULT_ALT_FT;
        dirty = true;
        break;
      }
      case ACTIONS.UNDO:
        if (selectedId) {
          draft = removeLastWaypoint(draft, selectedId);
          dirty = true;
          pushLive();
        }
        break;
      case ACTIONS.CLEAR:
        if (selectedId) {
          draft = clearWaypoints(draft, selectedId);
          dirty = true;
          pushLive();
        }
        break;
      case ACTIONS.LOOP:
        if (selectedId) {
          draft = setAircraftLoop(draft, selectedId, !selected()?.loop);
          dirty = true;
          pushLive();
        }
        break;
      case ACTIONS.REMOVE:
        if (selectedId) {
          draft = removeAircraft(draft, selectedId);
          selectedId = draft.aircraft[0]?.id || null;
          dirty = true;
          pushLive();
        }
        break;
      case ACTIONS.EXPORT:
        exportDocument();
        break;
      case ACTIONS.IMPORT:
        void importDocument();
        break;
      default:
        break;
    }
  }

  return {
    id: EDITOR_LAYER_ID,
    name: EDITOR_LAYER_NAME,
    icon: '✏️',
    source: 'Scenario file · AUTHORING',
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    enable() {
      enabled = true;
      error = null;
      if (!dirty) adoptDocument(simulation.getDocument?.() || null);
      unsubscribe?.();
      const off = simulation.subscribe?.(() => {
        if (!dirty) {
          adoptDocument(simulation.getDocument?.() || null);
          notify();
        }
      });
      unsubscribe = typeof off === 'function' ? off : null;
      notify();
      return true;
    },
    disable() {
      stopAdding();
      enabled = false;
      unsubscribe?.();
      unsubscribe = null;
      return true;
    },
    update() {
      return true;
    },
    getParams() {
      return { mode, altFt, selected: selectedId };
    },
    /** `mode`, `select`, `altFt` are state; `action` runs one editor command. */
    setParams(patch = {}) {
      // A selection resets the altitude to that aircraft's; an explicit altitude in the same patch wins.
      if (Object.hasOwn(patch, 'select')) {
        const id = String(patch.select || '');
        if (draft.aircraft.some((entry) => entry.id === id)) {
          selectedId = id;
          altFt = waypointDefaults(draft, id).altFt;
        }
      }
      if (Object.hasOwn(patch, 'altFt')) {
        const value = Number(patch.altFt);
        if (Number.isFinite(value))
          altFt = clamp(Math.round(value), ...ALT_FT_LIMITS);
      }
      if (Object.hasOwn(patch, 'action')) runAction(String(patch.action));
      if (Object.hasOwn(patch, 'mode') && MODES.includes(patch.mode)) {
        if (patch.mode === 'add') startAdding();
        else stopAdding();
      }
      notify();
      return true;
    },
    getRowControls() {
      const summary = documentSummary(draft);
      const current = selected();
      const busy = busyOwner
        ? t('{owner} is using the pointer — close it first', {
            owner: translateKnown(pointerOwnerName(busyOwner)),
          })
        : null;
      return {
        segmented: {
          id: 'editor-mode',
          label: t('Editing'),
          ariaLabel: t('Scenario editing mode'),
          options: [
            {
              id: 'mode-off',
              label: t('Off'),
              active: mode === 'off',
              params: { mode: 'off' },
            },
            {
              id: 'mode-add',
              label: t('Add waypoints'),
              title: t(
                'Click the globe to add waypoints to the selected aircraft',
              ),
              active: mode === 'add',
              params: { mode: 'add' },
            },
          ],
        },
        slider: {
          id: 'waypoint-altitude',
          label: t('New waypoint altitude'),
          ariaLabel: t('Altitude of new waypoints, feet above sea level'),
          valueText: t('{value} ft', { value: altFt }),
          min: ALT_FT_LIMITS[0],
          max: ALT_FT_LIMITS[1],
          step: ALT_FT_STEP,
          value: altFt,
          params: (value) => ({ altFt: Number(value) }),
        },
        list: {
          ariaLabel: t('Scenario aircraft and editor actions'),
          items: [
            ...draft.aircraft.map((entry, index) => ({
              id: entry.id,
              ordinal: index + 1,
              lead: entry.callsign || entry.id,
              text: `${entry.typeCode || ''} · ${t('{count} waypoints', { count: entry.waypoints?.length || 0 })} · ${entry.loop === false ? t('once') : t('loop')}`,
              accent: entry.color,
              active: entry.id === selectedId,
              params: { select: entry.id },
            })),
            {
              id: ACTIONS.NEW,
              ordinal: 0,
              lead: '+',
              text: t('New aircraft'),
              params: { action: ACTIONS.NEW },
            },
            {
              id: ACTIONS.UNDO,
              ordinal: 0,
              lead: '↶',
              text: t('Undo last waypoint'),
              disabled: !current?.waypoints?.length,
              params: { action: ACTIONS.UNDO },
            },
            {
              id: ACTIONS.LOOP,
              ordinal: 0,
              lead: '⟳',
              text:
                current?.loop === false
                  ? t('Fly once → loop')
                  : t('Loop → fly once'),
              disabled: !current,
              params: { action: ACTIONS.LOOP },
            },
            {
              id: ACTIONS.CLEAR,
              ordinal: 0,
              lead: '⌫',
              text: t('Clear path'),
              disabled: !current?.waypoints?.length,
              params: { action: ACTIONS.CLEAR },
            },
            {
              id: ACTIONS.REMOVE,
              ordinal: 0,
              lead: '−',
              text: t('Remove aircraft'),
              disabled: !current,
              params: { action: ACTIONS.REMOVE },
            },
            {
              id: ACTIONS.EXPORT,
              ordinal: 0,
              lead: '⤓',
              text: t('Export scenario JSON'),
              params: { action: ACTIONS.EXPORT },
            },
            {
              id: ACTIONS.IMPORT,
              ordinal: 0,
              lead: '⤒',
              text: t('Import scenario JSON'),
              params: { action: ACTIONS.IMPORT },
            },
          ],
        },
        info:
          busy ||
          (error
            ? error
            : `${draft.title || draft.id} · ${t('{count} aircraft', { count: summary.aircraft })} · ${t('{count} waypoints', { count: summary.waypoints })}${dirty ? ` · ${t('unsaved')}` : ''}`),
      };
    },
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    getStats() {
      return {
        count: draft.aircraft.length,
        error: busyOwner ? `${busyOwner} is using the pointer` : error,
        loading: false,
      };
    },
    /** The draft itself, for export tooling and tests. */
    getDocument() {
      return cloneDocument(draft);
    },
    exportDocument,
    diagnostics() {
      return {
        enabled,
        mode,
        selectedId,
        altFt,
        dirty,
        error,
        busyOwner,
        summary: documentSummary(draft),
        pointerHeld: Boolean(lease),
      };
    },
    destroy() {
      this.disable();
      viewer = null;
      rowControlsListener = null;
    },
  };
}

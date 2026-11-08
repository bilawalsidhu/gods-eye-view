// Mapped Installations' display under test, on a ground harness of
// src/testSupport/groundDisplayEngines.mjs (the fake engine or the Cesium
// engine, passed in): the layer's own
// state and model over test services, with the display's parts assigned as
// the layer assigns them (../index.js). `markers(setId)` reads a point
// set's drawn instances on either engine.

import * as contextStore from '../../../data/contextStore.js';
import { createModel } from '../model.js';
import { createState } from '../state.js';
import { createInstallationsDisplay } from './display.js';

const children = (collection) =>
  Array.from({ length: collection?.length ?? 0 }, (_, index) =>
    collection.get(index),
  );

/** The Cesium collection drawing a mover set. */
function cesiumCollection(viewer, id) {
  for (const root of children(viewer.scene.primitives))
    for (const child of children(root))
      if (child.gevMoverSet === id) return child;
  return undefined;
}

/**
 * @param {Function} makeEngine A ground harness factory.
 * @param {{ context?: object, overlayHost?: object,
 *   warmFloors?: (cells: object[]) => Promise<any> }} [options]
 *   `context` replaces the shared context store.
 */
export function createDisplayHarness(
  makeEngine,
  {
    context = contextStore,
    overlayHost = null,
    warmFloors = null,
    displayFactory = createInstallationsDisplay,
  } = {},
) {
  // The context store lives on the window.
  const ownWindow = globalThis.window === undefined;
  if (ownWindow) globalThis.window = new EventTarget();
  const h = makeEngine();
  const state = createState({ services: {} });
  const floors = new Map();
  const labels = { entries: [], policy: null, visible: false, publications: 0 };
  let mapStackListener = null;
  let mapStackRemoved = 0;
  let loads = 0;
  let photoreal = false;
  h.engine.maps.photorealActive = () => photoreal;
  const services = {
    render: { governorRequestRender() {} },
    context,
    ground: {
      cachedGroundFloor: (lat, lon) => floors.get(`${lat},${lon}`) ?? null,
      floorAltitudeM: (_position, floor) => floor ?? null,
    },
    anchors: { warmFireAnchorFloors: warmFloors ?? (async () => false) },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    maps: {
      subscribeMapStack(callback) {
        mapStackListener = callback;
        return () => {
          mapStackListener = null;
          mapStackRemoved++;
        };
      },
    },
  };
  const parts = {};
  const ctx = {
    state,
    services,
    parts,
    source: {},
    overlayHost: overlayHost ?? {
      setEntries(_id, entries, policy) {
        labels.entries = entries;
        labels.policy = policy;
        labels.publications++;
      },
      clearSource() {
        labels.entries = [];
      },
      setVisible(_id, visible) {
        labels.visible = visible;
      },
    },
  };
  parts.model = createModel(ctx);
  parts.viewport = {
    scheduleLoad: () => loads++,
    clearUnavailableRetry() {},
  };
  parts.ingestion = { setInstallationStatus() {} };
  parts.display = displayFactory(h.engine, ctx);
  const methods = parts.display;
  return {
    ...h,
    state,
    services,
    parts,
    labels,
    floors,
    loads: () => loads,
    setRecords(records) {
      state.records = records;
      state.recordById = new Map(records.map((record) => [record.id, record]));
    },
    /** init() and enable(), as the layer manager runs them. */
    start() {
      methods.init();
      methods.enable();
    },
    setPhotoreal(value) {
      photoreal = value;
    },
    changeMapStack: () => mapStackListener?.(),
    mapStackRemoved: () => mapStackRemoved,
    /** A point set's drawn instances: pickId, color (rgba 0..1), show, position. */
    markers(id) {
      const count =
        h.engine.movers.list().find((entry) => entry.id === id)?.count ?? 0;
      if (h.cesium) {
        const collection = cesiumCollection(h.viewer, id);
        return children(collection)
          .slice(0, count)
          .map((point) => ({
            pickId: point.id,
            color: [
              point.color.red,
              point.color.green,
              point.color.blue,
              point.color.alpha,
            ],
            show: point.show,
            position: point.position,
            point,
          }));
      }
      const { store } = h.engine.fake.moverSet(id);
      return Array.from({ length: count }, (_, index) => ({
        pickId: store.pickIds[index],
        color: Array.from(store.colors.slice(index * 4, index * 4 + 4)),
        show: store.shows[index] === 1,
        position: {
          x: store.positions[index * 3],
          y: store.positions[index * 3 + 1],
          z: store.positions[index * 3 + 2],
        },
      }));
    },
    /** The Cesium collection of a point set (Cesium only). */
    collection: (id) => cesiumCollection(h.viewer, id),
    destroy() {
      methods.destroy();
      h.destroy();
      if (ownWindow) delete globalThis.window;
    },
  };
}

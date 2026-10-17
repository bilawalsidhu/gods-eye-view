/**
 * The action runner wired to fakes that behave like the real services:
 * aircraft records, an annotation board, the referent registry and a turn
 * pointer. Shared by the cross-feature voice contract tests.
 */
import { createGevActionRunner } from './gevActions.js';
import { createReferentRegistry } from './referents.js';

globalThis.window = globalThis.window || {
  clearTimeout,
  setTimeout,
  requestIdleCallback: null,
};

/** An annotation board that marks every spec it is given. */
function fakeAnnotations() {
  const marks = [];
  let seq = 0;
  return {
    marks,
    async annotate(specs) {
      const results = specs.map((spec) => {
        const mark = {
          id: `anno-${(seq += 1)}`,
          label: spec.label,
          target: spec.target,
          createdAt: seq,
        };
        marks.push(mark);
        return { ok: true, id: mark.id, target: spec.target };
      });
      return { drawn: results.length, failed: 0, results };
    },
    list: () => marks,
  };
}

/** The runner with aircraft, annotations, referents and a turn pointer wired. */
export function harness({
  flights = null,
  pointer = null,
  on = ['flights'],
} = {}) {
  const modules = {
    flights: flights || {
      getStats: () => ({ count: 3, lastUpdate: Date.now() }),
      getAnalystRecords: () => [
        { id: 'UAL1', icao24: 'a1', callsign: 'UAL1', lat: 30, lon: -97 },
        { id: 'DAL2', icao24: 'a2', callsign: 'DAL2', lat: 30.1, lon: -97 },
        { id: 'SWA3', icao24: 'a3', callsign: 'SWA3', lat: 30.2, lon: -97 },
      ],
    },
  };
  const enabled = new Set(on);
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      positionCartographic: {
        height: 300_000,
        latitude: 0.52,
        longitude: -1.71,
      },
    },
  };
  const referents = createReferentRegistry();
  let snapshot = pointer;
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    annotations: fakeAnnotations(),
    annotationResolver: {
      resolveRegionRingForQuery: async () => null,
      resolveAnnotationTarget: async () => ({ lat: 37.795, lon: -122.393 }),
    },
    deixis: {
      pointer: { activeSnapshot: () => snapshot },
      referents,
      cameraKey: () => null,
    },
    dataManager: {
      layers: new Map(
        Object.entries(modules).map(([id, module]) => [id, { module }]),
      ),
      isEnabled: (id) => enabled.has(id),
      getAll: () =>
        Object.entries(modules).map(([id, module]) => ({
          id,
          name: id,
          enabled: enabled.has(id),
          stats: module.getStats?.() || {},
        })),
      async setEnabled(id, on) {
        if (on) enabled.add(id);
        else enabled.delete(id);
        return true;
      },
    },
  });
  return {
    runner,
    referents,
    setPointer: (next) => (snapshot = next),
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

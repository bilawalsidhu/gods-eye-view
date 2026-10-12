/**
 * QA host for the embeddable application (scripts/qa-embedded.mjs).
 * A host-owned header plus one root element, an in-memory ProjectionSource
 * over the retained Experiment 002 fixtures, and no provider API.
 *
 * `?live` (or `?live=<base url>`, default `/world`) reads a running backplane
 * over HTTP instead, and starts on load: the UI against a real world.
 */
import '../../src/embedded/embedded.css';
import { createEmbeddedApplication } from '../../src/embedded/application.js';
import { createHttpProjectionSource } from '../../src/layers/worldModel/source.js';
import projection from '../../src/layers/worldModel/fixtures/experiment-002.projection.json';
import revisions from '../../src/layers/worldModel/fixtures/experiment-002.revisions.json';
import status from '../../src/layers/worldModel/fixtures/experiment-002.status.json';
import effectsPair from '../../src/layers/worldModel/fixtures/run-effects.pair.json';

// GEN-299: both cases of Foundation's ground-rf-mission run, mission effects only
// (the runs World Model holds before DWM-218), served beside Experiment 002.
const runs = new Map(
  ['contested', 'nominal'].map((label) => [
    effectsPair[label].head,
    effectsPair[label],
  ]),
);
const byRevision = new Map(
  [...runs.values()].map((run) => [run.revision_id, run]),
);

function runStatus(run) {
  const bindings = Object.entries(run.selections).map(
    ([binding, selection]) => {
      const times = selection.products[0].values
        .map((row) => row.valid_time)
        .sort();
      return {
        binding,
        modality: 'simulated',
        representations: [{ kind: 'sample_series/v1' }],
        valid: { earliest: times[0], latest: times.at(-1) },
      };
    },
  );
  return { ...structuredClone(status), head: { name: run.head }, bindings };
}

const fixtureSource = {
  async getHeads() {
    return {
      'world/main': revisions.revisions[0].id,
      ...Object.fromEntries(
        [...runs.values()].map((run) => [run.head, run.revision_id]),
      ),
    };
  },
  async getRevisions({ head, limit = 10 }) {
    const run = runs.get(head);
    if (run) return { head, revisions: [structuredClone(run.revision)] };
    return { head, revisions: revisions.revisions.slice(0, limit) };
  },
  async getRevision({ revisionId }) {
    return structuredClone(byRevision.get(revisionId).revision);
  },
  async getProjection() {
    return structuredClone(projection);
  },
  async getStatus({ head } = {}) {
    const run = runs.get(head);
    return run ? runStatus(run) : structuredClone(status);
  },
  async select({ revisionId, head, query }) {
    const run = byRevision.get(revisionId) ?? runs.get(head);
    const binding = query?.requested_layers?.[0];
    return structuredClone(run?.selections[binding] ?? { products: [] });
  },
};

let app = null;
const params = new URLSearchParams(location.search);
const live = params.has('live');
const source = live
  ? createHttpProjectionSource({ baseUrl: params.get('live') || '/world' })
  : fixtureSource;
window.__renderErrors = [];
window.__embeddedQa = {
  async create() {
    app = createEmbeddedApplication({
      root: document.getElementById('host-root'),
      worldModelSource: source,
      cesiumToken: params.get('cesiumToken') || null,
      initialCamera: {
        lon: -122.25,
        lat: 37.62,
        rangeM: 95000,
        headingDeg: 0,
        pitchDeg: -35,
      },
      worldModel: { updateInterval: 5000 },
    });
    await app.start();
    app
      .getComponents()
      .scene.viewer.scene.renderError.addEventListener((_, error) =>
        window.__renderErrors.push(
          String(error?.stack || error?.message || error),
        ),
      );
    return app.getState().status;
  },
  async enableWorldModel() {
    const { dataManager } = app.getComponents().data;
    await dataManager.setEnabled('world-model', true, { origin: 'user' });
    return dataManager.isEnabled('world-model');
  },
  /** Enable every registered layer; each reports its own outcome. */
  async enableAllLayers() {
    const { dataManager } = app.getComponents().data;
    const outcomes = {};
    for (const id of [...dataManager.layers.keys()]) {
      try {
        await dataManager.setEnabled(id, true, { origin: 'user' });
        outcomes[id] = dataManager.getLayerLifecycleState(id);
      } catch (error) {
        outcomes[id] = { threw: String(error?.message || error) };
      }
    }
    return outcomes;
  },
  /** GEN-299: open the contested run of the effects pair, compared with its nominal case. */
  async openEffectsPair() {
    const { contested, nominal } = effectsPair;
    return app.openRun(contested.head, {
      revisionId: contested.revision_id,
      compare: { head: nominal.head, revisionId: nominal.revision_id },
    });
  },
  renderedIds() {
    const layer = app
      ?.getComponents()
      .data?.dataManager?.layers.get('world-model')?.module;
    return layer ? layer.getRenderedIds() : [];
  },
  async destroy() {
    const flatten = (error) =>
      error?.errors
        ? error.errors.flatMap(flatten)
        : [
            `${error?.name}: ${error?.message}\n${String(error?.stack || '')
              .split('\n')
              .slice(1, 4)
              .join('\n')}`,
          ];
    try {
      await app.destroy();
    } catch (error) {
      return { status: app.getState().status, errors: flatten(error) };
    } finally {
      window.__lastApp = app;
    }
    const status = app.getState().status;
    app = null;
    return status;
  },
};

if (live)
  window.__embeddedQa
    .create()
    .catch((error) => console.error('[embedded-qa] start failed:', error));

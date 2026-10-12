/**
 * Opening one simulation run for the host (DWM-196).
 *
 * A run is a `sim/` head the world model forked for it. Its simulated
 * products are already rows of the panel (DWM-189), each opened on the newest
 * run that holds it. A host that links to a particular run -- Dataforge's
 * "Visualize in World Model" from a published scenario run -- asks for THAT
 * run: every row the run has a product for is pointed at the run's head and
 * time and switched on. Nothing else changes, and no hidden layer is involved.
 *
 * A simulated product with no row is reported, not dropped: today's RF
 * mission-effect series have no position to draw, and the host says so rather
 * than showing an empty globe as if the run had nothing in it.
 *
 * A host that holds a publication receipt names its revision too (GEN-299):
 * every row is pinned to exactly that revision, never to whatever the head
 * says now, and a head that has moved past it is reported. A revision that is
 * not on the head, or a head with no simulated product, is refused with a
 * reason the host can show -- never an empty globe. The host can name the
 * other case of the same pair (`compare`, the nominal run): the run player
 * then shows both runs' mission effects and where they differ. A comparison
 * that cannot be opened is reported, and the run still opens.
 */
import { focusRun } from '../layers/worldModel/runFocus.js';
import { SIM_HEAD_PREFIX } from '../layers/worldModel/simulationRuns.js';
import { DRAWABLE_REPRESENTATIONS, productLayerId } from './worldProducts.js';

export const RUN_OPEN_ERROR_CODES = Object.freeze([
  'revision-not-on-head',
  'no-simulated-products',
]);

/** Why a run could not be opened; `message` is safe to show the user. */
export class RunOpenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunOpenError';
    this.code = code;
  }
}

/** How far back a receipt's revision is looked for on its head. */
const REVISION_CHAIN_LIMIT = 50;

/**
 * @param {object} options
 * @param {object} options.manager The DataLayerManager (`getComponents().data.dataManager`).
 * @param {object} options.source The host's ProjectionSource.
 * @param {string} options.head A `sim/` head.
 * @param {string|null} [options.validAt] Where to open the run; null = each product's first epoch.
 * @param {string|null} [options.revisionId] The receipt's revision: rows are pinned to it.
 * @param {{head: string, revisionId?: string|null}|null} [options.compare] The pair's other case.
 * @returns {Promise<{head: string, revisionId: string|null, headAdvanced: boolean,
 *   interval: {start: string, end: string}|null, compareError: string|null,
 *   opened: Array<{binding: string, layerId: string, validAt: string|null}>,
 *   undrawable: Array<{binding: string, reason: string}>}>}
 */
export async function openRun({
  manager,
  source,
  head,
  validAt = null,
  revisionId = null,
  compare = null,
  signal,
}) {
  if (typeof head !== 'string' || !head.startsWith(SIM_HEAD_PREFIX))
    throw new TypeError(
      `openRun takes a ${SIM_HEAD_PREFIX} head, got ${JSON.stringify(head)}`,
    );
  if (!manager?.layers)
    throw new Error('openRun: the application is not running');
  const { headAdvanced } = await checkRevision(source, head, revisionId, signal);
  const status = await source.getStatus({ head, signal });
  const simulated = (status?.bindings ?? []).filter(
    (entry) =>
      entry?.modality === 'simulated' && typeof entry.binding === 'string',
  );
  if (!simulated.length)
    throw new RunOpenError(
      'no-simulated-products',
      `${head} has no simulated products: it is not a published run, or its ` +
        'publication did not finish. Retry the publication from the scenario.',
    );
  const opened = [];
  const undrawable = [];
  for (const entry of simulated) {
    const layerId = productLayerId(entry.binding);
    if (!manager.layers.has(layerId)) {
      const drawable = (entry.representations ?? []).some((r) =>
        DRAWABLE_REPRESENTATIONS.includes(r?.kind),
      );
      undrawable.push({
        binding: entry.binding,
        reason: drawable
          ? 'no panel row (not discovered at start-up)'
          : 'no position to draw',
      });
      continue;
    }
    const at = validAt ?? entry.valid?.earliest ?? null;
    const pin =
      revisionId === null ? {} : { follow: 'pinned', revisionId };
    if (!manager.setLayerParams(layerId, { head, validAt: at, ...pin }))
      throw new Error(`openRun: ${layerId} refused head ${head}`);
    await manager.setEnabled(layerId, true);
    opened.push({ binding: entry.binding, layerId, validAt: at });
  }
  let compareError = null;
  let comparison = null;
  if (compare?.head) {
    try {
      if (!compare.head.startsWith(SIM_HEAD_PREFIX))
        throw new RunOpenError('no-simulated-products', `${compare.head} is not a run head`);
      await checkRevision(source, compare.head, compare.revisionId ?? null, signal);
      comparison = { head: compare.head, revisionId: compare.revisionId ?? null };
    } catch (error) {
      compareError = `The nominal run cannot be compared: ${error.message}`;
    }
  }
  focusRun({ head, revisionId, headAdvanced, source, compare: comparison });
  return {
    head,
    revisionId,
    headAdvanced,
    interval: intervalOf(simulated),
    compareError,
    opened,
    undrawable,
  };
}

/** A receipt's revision must be on its head; whether the head has moved past it. */
async function checkRevision(source, head, revisionId, signal) {
  if (revisionId === null) return { headAdvanced: false };
  const chain = await source.getRevisions({
    head,
    limit: REVISION_CHAIN_LIMIT,
    signal,
  });
  const ids = (chain?.revisions ?? []).map((revision) => revision.id);
  if (!ids.includes(revisionId))
    throw new RunOpenError(
      'revision-not-on-head',
      `Revision ${revisionId.slice(0, 8)} is not on ${head}. ` +
        'The link may be for another world model, or the run was published again: ' +
        'open the run from its scenario to get a current link.',
    );
  return { headAdvanced: ids[0] !== revisionId };
}

/** The run's interval: the earliest and latest stored epochs over its simulated products. */
function intervalOf(simulated) {
  const starts = simulated.map((e) => e.valid?.earliest).filter(Boolean);
  const ends = simulated.map((e) => e.valid?.latest).filter(Boolean);
  if (!starts.length || !ends.length) return null;
  const pick = (values, better) =>
    values.reduce((a, b) => (better(Date.parse(b), Date.parse(a)) ? b : a));
  return {
    start: pick(starts, (b, a) => b < a),
    end: pick(ends, (b, a) => b > a),
  };
}

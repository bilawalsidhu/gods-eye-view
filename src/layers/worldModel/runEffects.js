/**
 * A run's mission effects as lanes the run player draws (GEN-299).
 *
 * Foundation publishes what the receiver's state did to the mission as three
 * sample series on the run's head: communications (bytes delivered per
 * exchange), collection (observations kept) and navigation (fix sigmas). They
 * have no position, so they are lanes under the SINR strip, not globe layers.
 * Every cell is one published row, read, never re-derived:
 *
 *  - its state is the row's `state_code`; UNKNOWN stays a state of its own and
 *    is never drawn as an outage (the player hatches it);
 *  - opportunities that share an epoch stay separate cells, stacked, never
 *    merged (the series key is the opportunity, not the epoch);
 *  - the reason is the row's `reason_code` named by the product's own legend,
 *    and the model, its calibration status and its assumptions come from the
 *    product's header, so an illustrative model says so next to its output.
 *
 * Two runs of one pair (nominal and contested) compare cell by cell: the
 * same family, opportunity and epoch, a different state.
 *
 * Pure and DOM-free: `ui/runPlayer.js` draws what this module computes.
 */
import { RECEIVER_STATES } from './receiverPass.js';

export const EFFECT_FAMILIES = Object.freeze([
  Object.freeze({
    family: 'communications',
    binding: 'simulation.rf.communications',
    label: 'Comms',
  }),
  Object.freeze({
    family: 'collection',
    binding: 'simulation.rf.collection',
    label: 'Collection',
  }),
  Object.freeze({
    family: 'navigation',
    binding: 'simulation.rf.navigation',
    label: 'Navigation',
  }),
]);

export const UNKNOWN_STATE = 4;

/** Every row of one family over the whole run (a sample series answers stored epochs only). */
export function effectsQuery(binding) {
  return {
    modalities: ['simulated'],
    requested_layers: [binding],
    predicates: {
      interval: { start: '1970-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' },
    },
  };
}

function stateOf(code) {
  const value = code === null || code === undefined ? Number.NaN : Number(code);
  return Number.isInteger(value) && RECEIVER_STATES[value]
    ? value
    : UNKNOWN_STATE;
}

function bytes(n) {
  return Number.isFinite(n) ? `${n} B` : '? B';
}

function metres(n) {
  return Number.isFinite(n) ? `${n < 10 ? n.toFixed(1) : Math.round(n)} m` : null;
}

/** What the row says happened to the mission, in words; null when the row does not say. */
export function outcomeOf(family, value) {
  if (!value || value.available === null || value.available === undefined)
    return null;
  if (family === 'communications')
    return `${bytes(value.delivered_bytes)} of ${bytes(value.attempted_bytes)} delivered`;
  if (family === 'collection')
    return value.observation_retained ? 'observation kept' : 'observation lost';
  if (family === 'navigation') {
    const position = metres(value.position_sigma_m);
    return position ? `position σ ${position}` : 'no fix';
  }
  return null;
}

/**
 * One family's selection -> its lane, or null when the run has none.
 * @param {object} familyEntry One of EFFECT_FAMILIES.
 * @param {object} selection `POST /select` of the family's binding.
 * @param {object|null} [metadata] The descriptor's `semantic.metadata` (the product header), if known.
 */
export function laneFrom(familyEntry, selection, metadata = null) {
  const values = (selection?.products ?? []).flatMap((product) =>
    Array.isArray(product?.values) ? product.values : [],
  );
  if (!values.length) return null;
  const reasons = metadata?.reason_codes ?? null;
  const cells = values
    .map((row) => {
      const at = Date.parse(row?.valid_time);
      const value = row?.value ?? {};
      const state = stateOf(value.state_code);
      const reasonCode =
        value.reason_code === null || value.reason_code === undefined
          ? null
          : Number(value.reason_code);
      return {
        at,
        validAt: row.valid_time,
        opportunity: String(row?.series_key?.opportunity ?? row?.ordinal ?? ''),
        state,
        stateName: RECEIVER_STATES[state].name,
        unknown: state === UNKNOWN_STATE,
        reasonCode,
        reason:
          reasonCode === null
            ? null
            : (reasons?.[String(reasonCode)] ?? `reason ${reasonCode}`),
        available: value.available ?? null,
        outcome: outcomeOf(familyEntry.family, value),
      };
    })
    .filter((cell) => Number.isFinite(cell.at))
    .sort((a, b) => a.at - b.at || a.opportunity.localeCompare(b.opportunity));
  // Same-epoch opportunities stack: each keeps its own cell.
  let depth = 1;
  const seen = new Map();
  for (const cell of cells) {
    cell.stack = seen.get(cell.at) ?? 0;
    seen.set(cell.at, cell.stack + 1);
    depth = Math.max(depth, cell.stack + 1);
  }
  return {
    family: familyEntry.family,
    binding: familyEntry.binding,
    label: familyEntry.label,
    depth,
    cells,
  };
}

/** The cells of a lane at one epoch (several when opportunities share it). */
export function cellsAt(lane, ms) {
  return lane?.cells.filter((cell) => cell.at === ms) ?? [];
}

/**
 * What the run's effects rest on, from the product headers: each model and
 * its calibration status, and the assumptions, once each. Null when no
 * header was read, so the player says the model is unknown instead of
 * implying a validated one.
 */
export function modelCardOf(metadataByFamily) {
  const entries = Object.entries(metadataByFamily ?? {}).filter(
    ([, metadata]) => metadata,
  );
  if (!entries.length) return null;
  const models = entries.map(([family, metadata]) => ({
    family,
    id: metadata.model?.id ?? null,
    version: metadata.model?.version ?? null,
    calibrationStatus: metadata.model?.calibration_status ?? 'unstated',
    validated: !!metadata.model?.validation_report_content_id,
  }));
  const assumptions = [
    ...new Set(entries.flatMap(([, m]) => m.assumptions ?? [])),
  ];
  return {
    models,
    assumptions,
    uncalibrated: models.some((m) => !m.validated),
  };
}

/**
 * Contested against nominal, cell by cell: the same family, opportunity and
 * epoch with a different state. A cell only one run has is not a difference
 * the comparison can state, so it is left out.
 */
export function compareLanes(contested, nominal) {
  const key = (family, cell) => `${family}|${cell.opportunity}|${cell.at}`;
  const other = new Map();
  for (const lane of nominal ?? [])
    for (const cell of lane.cells) other.set(key(lane.family, cell), cell);
  const differences = [];
  for (const lane of contested ?? [])
    for (const cell of lane.cells) {
      const twin = other.get(key(lane.family, cell));
      if (twin && twin.state !== cell.state)
        differences.push({
          family: lane.family,
          opportunity: cell.opportunity,
          at: cell.at,
          contested: cell.stateName,
          nominal: twin.stateName,
        });
    }
  return differences;
}

/** The descriptors' header metadata of one revision, by binding; {} when the source cannot say. */
async function headersOf(source, at) {
  if (typeof source?.getRevision !== 'function' || !at.revisionId) return {};
  const revision = await source.getRevision({ revisionId: at.revisionId });
  const out = {};
  for (const [binding, descriptor] of Object.entries(revision?.descriptors ?? {}))
    out[binding] = descriptor?.semantic?.metadata ?? null;
  return out;
}

/**
 * A run's effects per revision (read once each; a failed read is retried).
 * Resolves to `{lanes, card}`, with no lanes when the run has no effects.
 */
export function createRunEffects(source) {
  const cache = new Map();
  async function load(at) {
    const headers = await headersOf(source, at).catch(() => ({}));
    const lanes = [];
    const byFamily = {};
    for (const entry of EFFECT_FAMILIES) {
      const selection = await source.select({
        ...at,
        query: effectsQuery(entry.binding),
      });
      const metadata = headers[entry.binding] ?? null;
      const lane = laneFrom(entry, selection, metadata);
      if (!lane) continue;
      lanes.push(lane);
      byFamily[entry.family] = metadata;
    }
    return { lanes, card: lanes.length ? modelCardOf(byFamily) : null };
  }
  return {
    async read({ revisionId = null, head = null } = {}) {
      if (typeof source?.select !== 'function' || !(revisionId || head))
        return { lanes: [], card: null };
      const key = revisionId ?? `head:${head}`;
      if (!cache.has(key)) {
        const pending = load(revisionId ? { revisionId } : { head });
        cache.set(key, pending);
        pending.catch(() => cache.delete(key));
      }
      return cache.get(key);
    },
  };
}

/**
 * A run with mission effects but no receiver track still plays: its epochs are
 * the effects' own stored ones, every one of them, never a resampled grid.
 */
export function effectsTimeline(lanes) {
  const epochs = [...new Set(lanes.flatMap((lane) => lane.cells.map((c) => c.at)))].sort(
    (a, b) => a - b,
  );
  if (!epochs.length) return null;
  const gaps = new Map();
  for (let i = 1; i < epochs.length; i++) {
    const gap = epochs[i] - epochs[i - 1];
    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  const [cadenceMs] = [...gaps].sort((a, b) => b[1] - a[1])[0] ?? [null];
  return {
    binding: null,
    label: 'Mission effects (simulated)',
    start: epochs[0],
    end: epochs.at(-1),
    cadenceMs: cadenceMs ?? 1000,
    thresholds: [],
    rows: epochs.map((at) => ({
      at,
      validAt: new Date(at).toISOString().replace('.000Z', 'Z'),
      sinrDb: null,
      jammerActive: null,
    })),
  };
}

/** The cells in force at `ms`: each lane's last epoch at or before it. */
export function cellsInForce(lane, ms) {
  let at = null;
  for (const cell of lane.cells) {
    if (cell.at > ms) break;
    at = cell.at;
  }
  return at === null ? [] : cellsAt(lane, at);
}

/** "COMMS degraded · COLLECTION unavailable · NAVIGATION unknown" at `ms`, read from the cells. */
export function effectsBannerText(lanes, ms) {
  return lanes
    .map((lane) => {
      const names = [...new Set(cellsInForce(lane, ms).map((c) => c.stateName))];
      return names.length ? `${lane.label.toUpperCase()} ${names.join('/')}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}

/**
 * The lanes' boxes in a strip `width` wide: one row per lane (a stacked
 * opportunity gets its own sub-row), a cell spanning its epoch to the lane's
 * next epoch (at most one cadence step, so an off-grid row is no wider than
 * the time it holds), and a comparison lane under each of its runs' lanes.
 * @param {Array<{lane: object, label: string, run: string}>} rows Lanes in draw order.
 * @param {{x: (ms: number) => number, cadenceMs: number, subRowHeight?: number, gap?: number}} scale
 */
export function lanesGeometry(rows, { x, cadenceMs, subRowHeight = 8, gap = 4 }) {
  const out = [];
  let y = 0;
  for (const { lane, label, run } of rows) {
    const height = lane.depth * subRowHeight;
    const epochs = [...new Set(lane.cells.map((c) => c.at))].sort((a, b) => a - b);
    const next = new Map(epochs.map((at, i) => [at, epochs[i + 1] ?? at + cadenceMs]));
    out.push({
      label,
      run,
      family: lane.family,
      y,
      height,
      cells: lane.cells.map((cell) => ({
        cell,
        x: x(cell.at),
        y: y + cell.stack * subRowHeight,
        width: Math.max(2, x(Math.min(next.get(cell.at), cell.at + cadenceMs)) - x(cell.at) - 1),
        height: subRowHeight - 1,
      })),
    });
    y += height + gap;
  }
  return { rows: out, height: Math.max(0, y - gap) };
}

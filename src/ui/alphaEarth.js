/**
 * The AlphaEarth Change readout in its right-rail body: box actions, the
 * year pair, detail, threshold, legend and the comparison's statistics. The
 * DOM is built once and updated in place from layer snapshots, so a
 * notification never steals focus from a select or the slider.
 */
import {
  ALPHA_EARTH_FAINT_FRACTION,
  ALPHA_EARTH_MIN_THRESHOLD,
  LEGEND_GRADIENT,
} from '../layers/alphaEarth/model.js';

const PANEL_ID = 'alpha-earth-panel';
// Remounting controls must not reopen a panel the user already collapsed.
const appearedDocuments = new WeakSet();

const percent = (value) =>
  Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : '—';
const fixed = (value) => (Number.isFinite(value) ? value.toFixed(2) : '—');
/** A result too quiet to see at this threshold, with a lower one that shows it. */
function faintResult(snapshot) {
  const result = snapshot.result;
  if (!result || !(result.changedFraction < ALPHA_EARTH_FAINT_FRACTION))
    return null;
  const reveal =
    result.revealThreshold != null &&
    result.revealThreshold < snapshot.threshold
      ? result.revealThreshold
      : null;
  return { strongest: result.strongest, reveal };
}
const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};

/**
 * @param {{ container: HTMLElement, layer: object, viewer?: object, tool?: { start: Function, cancel: Function, isActive: Function } | null }} options
 */
export function createAlphaEarthPanel({
  container,
  layer,
  viewer = null,
  tool = null,
} = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement || !layer) return null;
  const panel = document.getElementById?.(PANEL_ID) || null;
  const count = document.getElementById?.(`${PANEL_ID}-count`) || null;
  const listeners = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  };
  const el = (tag, className, parent, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    parent?.appendChild(node);
    return node;
  };

  const root = el('section', 'ae-readout');
  root.setAttribute('aria-label', 'AlphaEarth change');
  el(
    'p',
    'ae-hint',
    root,
    'Where the land changed between two years, from annual 10 m satellite embeddings. Draw a box up to 100 km.',
  );

  const actions = el('div', 'ae-actions', root);
  const selectBox = el(
    'button',
    'data-toggle-chip ae-btn',
    actions,
    'SELECT BOX',
  );
  selectBox.type = 'button';
  selectBox.title = 'Drag a box on the map (Esc cancels)';
  const useView = el('button', 'data-toggle-chip ae-btn', actions, 'USE VIEW');
  useView.type = 'button';
  useView.title = 'Use the current view as the box';
  const clear = el('button', 'data-toggle-chip ae-btn', actions, 'CLEAR');
  clear.type = 'button';

  const controls = el('div', 'ae-controls', root);
  const field = (label) => {
    const wrap = el('label', 'ae-field', controls);
    el('span', 'ae-label', wrap, label);
    return wrap;
  };
  const fromSelect = el('select', 'ae-select', field('FROM'));
  fromSelect.setAttribute('aria-label', 'From year');
  const toSelect = el('select', 'ae-select', field('TO'));
  toSelect.setAttribute('aria-label', 'To year');
  const detailSelect = el('select', 'ae-select', field('DETAIL'));
  detailSelect.setAttribute('aria-label', 'Detail');
  for (const [value, text] of [
    ['standard', 'Standard'],
    ['high', 'High (slower)'],
  ]) {
    const option = el('option', null, detailSelect, text);
    option.value = value;
  }

  const thresholdRow = el('label', 'ae-threshold', root);
  el('span', 'ae-label', thresholdRow, 'THRESHOLD');
  const threshold = el('input', 'ae-range', thresholdRow);
  threshold.type = 'range';
  threshold.min = '5';
  threshold.max = '95';
  threshold.step = '1';
  threshold.setAttribute('aria-label', 'Change threshold');
  const thresholdValue = el('span', 'ae-value', thresholdRow);

  const legend = el('div', 'ae-legend', root);
  const legendBar = el('div', 'ae-legend-bar', legend);
  legendBar.style.background = LEGEND_GRADIENT;
  const legendLabels = el('div', 'ae-legend-labels', legend);
  const legendLow = el('span', null, legendLabels);
  el('span', null, legendLabels, 'total change');

  const status = el('p', 'ae-status', root);
  status.setAttribute('role', 'status');
  const retry = el('button', 'data-toggle-chip ae-btn ae-retry', root, 'RETRY');
  retry.type = 'button';
  const reveal = el('button', 'data-toggle-chip ae-btn ae-reveal', root);
  reveal.type = 'button';
  reveal.title = 'Lower the threshold to the strongest 1% of change in the box';

  const stats = el('dl', 'ae-stats', root);
  const stat = (label) => {
    el('dt', null, stats, label);
    return el('dd', null, stats);
  };
  const statChanged = stat('Changed');
  const statMean = stat('Mean change');
  const statP95 = stat('95th percentile');
  const statResolution = stat('Resolution');
  const statCoverage = stat('Coverage');

  const attribution = el('p', 'ae-attribution', root);
  container.appendChild(root);

  let snapshot = layer.getSnapshot();
  let destroyed = false;
  let yearsKey = '';

  function syncYears() {
    const key = snapshot.years.join(',');
    if (key === yearsKey) return;
    yearsKey = key;
    for (const select of [fromSelect, toSelect]) {
      select.textContent = '';
      for (const year of snapshot.years) {
        const option = el('option', null, select, String(year));
        option.value = String(year);
      }
    }
  }

  function statusText() {
    if (snapshot.hostError) return snapshot.hostError;
    if (snapshot.boxError) return snapshot.boxError;
    if (snapshot.yearsError)
      return `Years unavailable · ${snapshot.yearsError}`;
    if (snapshot.yearsLoading) return 'Loading the embedding index…';
    if (snapshot.status === 'loading')
      return `Comparing ${snapshot.from} → ${snapshot.to} · reading embeddings, this can take half a minute`;
    if (snapshot.status === 'error') return snapshot.error;
    if (!snapshot.box)
      return snapshot.toolActive
        ? 'Drag a box on the map'
        : 'Select a box to compare';
    const faint = faintResult(snapshot);
    if (faint && faint.strongest < ALPHA_EARTH_MIN_THRESHOLD)
      return `This place barely changed · strongest change ${fixed(faint.strongest)}`;
    if (faint)
      return `Almost nothing reaches ${snapshot.threshold.toFixed(2)} here · strongest change ${fixed(faint.strongest)}`;
    if (snapshot.result)
      return `${snapshot.result.from} → ${snapshot.result.to} · annual embeddings, not single-day events`;
    return '';
  }

  function renderPanel() {
    const hidden = !snapshot.enabled;
    if (panel) set(panel, 'hidden', hidden);
    set(root, 'hidden', hidden);
    if (count)
      set(
        count,
        'textContent',
        hidden || !snapshot.result
          ? ''
          : `${percent(snapshot.result.changedFraction)} CHANGED`,
      );
    if (hidden || !panel || appearedDocuments.has(document)) return;
    appearedDocuments.add(document);
    // First appearance opens the panel unless a stored or shared collapse
    // choice exists (marked by the panel chrome when it restored the state).
    const preference = panel.dataset?.collapsedPreference;
    if (
      panel.classList.contains('collapsed') &&
      (preference === undefined || preference === 'default')
    )
      panel.querySelector?.(`[data-collapse-target="${PANEL_ID}"]`)?.click();
  }

  function render() {
    if (destroyed) return;
    renderPanel();
    syncYears();
    set(
      selectBox,
      'textContent',
      snapshot.toolActive ? 'CANCEL' : 'SELECT BOX',
    );
    set(clear, 'disabled', !snapshot.box);
    const busy = snapshot.status === 'loading';
    for (const select of [fromSelect, toSelect])
      set(select, 'disabled', snapshot.years.length < 2);
    if (snapshot.from != null) set(fromSelect, 'value', String(snapshot.from));
    if (snapshot.to != null) set(toSelect, 'value', String(snapshot.to));
    set(detailSelect, 'value', snapshot.detail);
    const pct = String(Math.round(snapshot.threshold * 100));
    if (document.activeElement !== threshold) set(threshold, 'value', pct);
    set(thresholdValue, 'textContent', snapshot.threshold.toFixed(2));
    set(legendLow, 'textContent', `≥ ${snapshot.threshold.toFixed(2)}`);
    set(status, 'textContent', statusText());
    set(root.dataset, 'status', snapshot.status);
    set(
      retry,
      'hidden',
      !(snapshot.status === 'error' || snapshot.yearsError) || busy,
    );
    const faint = faintResult(snapshot);
    set(reveal, 'hidden', !faint?.reveal || busy);
    if (faint?.reveal)
      set(
        reveal,
        'textContent',
        `SHOW STRONGEST 1% · ≥ ${faint.reveal.toFixed(2)}`,
      );
    const result = snapshot.result;
    set(stats, 'hidden', !result);
    set(legend, 'hidden', !result);
    if (result) {
      set(statChanged, 'textContent', percent(result.changedFraction));
      set(statMean, 'textContent', fixed(result.stats?.meanChange));
      set(statP95, 'textContent', fixed(result.stats?.p95Change));
      set(
        statResolution,
        'textContent',
        `${result.pixelMeters} m/px · ${result.width}×${result.height}`,
      );
      set(statCoverage, 'textContent', percent(result.stats?.validFraction));
    }
    set(attribution, 'textContent', snapshot.attribution);
  }

  listen(selectBox, 'click', () => {
    if (tool?.isActive()) tool.cancel('toggle');
    else tool?.start();
  });
  listen(useView, 'click', () => layer.useCurrentView(viewer));
  listen(clear, 'click', () => layer.clear());
  listen(retry, 'click', () => layer.retry());
  listen(reveal, 'click', () => {
    const next = faintResult(layer.getSnapshot())?.reveal;
    if (next != null) layer.setThreshold(next);
  });
  const onYears = () => {
    if (!layer.setYears(Number(fromSelect.value), Number(toSelect.value)))
      render();
  };
  listen(fromSelect, 'change', onYears);
  listen(toSelect, 'change', onYears);
  listen(detailSelect, 'change', () => layer.setDetail(detailSelect.value));
  listen(threshold, 'input', () =>
    layer.setThreshold(Number(threshold.value) / 100),
  );

  layer.setToolHandler?.(() => {
    if (tool?.isActive()) tool.cancel('layer');
  });
  const unsubscribe = layer.subscribe((next) => {
    if (destroyed) return;
    snapshot = next || layer.getSnapshot();
    render();
  });
  render();

  return {
    root,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      layer.setToolHandler?.(null);
      for (const [target, type, handler] of listeners.splice(0))
        target.removeEventListener(type, handler);
      root.remove();
      if (count) count.textContent = '';
      if (panel) panel.hidden = true;
    },
  };
}

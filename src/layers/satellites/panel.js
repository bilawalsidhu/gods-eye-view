import { satelliteClassLabel } from '../../data/satelliteClass.js';
import { ISS_NORAD } from './policy.js';

/** CelesTrak group tag → human filter-dropdown label (mirrors index.html's <option> values). */
const GROUP_LABELS = {
  stations: 'Space Stations',
  visual: 'Visual (Brightest)',
  'gps-ops': 'GPS',
  glonass: 'GLONASS',
  galileo: 'Galileo',
  geo: 'GEO Belt',
  dense: 'Starlink (Dense)',
};

const SEARCH_DEBOUNCE_MS = 150;
const RESULT_LIMIT = 50;

export function createPanel({ state: layerState, services, parts, source }) {
  function escapeSatelliteSearchText(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character],
    );
  }

  function groupLabel(group) {
    return GROUP_LABELS[group] || (group ? group.toUpperCase() : 'UNKNOWN');
  }

  /**
   * Repaint the search panel's status line and result roster from the
   * current catalog plus whatever query/group the inputs hold. Cheap to call
   * often: it no-ops before the panel exists, and does no catalog work while
   * the query and group are both empty.
   */
  function renderSatelliteSearchResults() {
    const panel = layerState._satellitePanel;
    if (!panel) return;
    const list = panel.querySelector('[data-satellite-search-list]');
    const status = panel.querySelector('[data-satellite-search-status]');
    const count = panel.querySelector('[data-satellite-search-count]');
    if (!list || !status || !count) return;

    const catalogSize = layerState._catalog?.size || 0;
    count.textContent = catalogSize ? `${catalogSize.toLocaleString()} LOADED` : '—';

    if (!layerState._enabled) {
      status.textContent = 'ENABLE SATELLITES TO SEARCH';
      list.innerHTML =
        '<div class="satellite-search-empty">ENABLE THE SATELLITES LAYER, THEN SEARCH BY NAME OR NORAD ID</div>';
      return;
    }
    if (catalogSize === 0) {
      status.textContent = 'LOADING CATALOG…';
      list.innerHTML =
        '<div class="satellite-search-empty">LOADING SATELLITE CATALOG…</div>';
      return;
    }

    const query = layerState._satelliteSearchQuery || '';
    const group = layerState._satelliteSearchGroup || '';
    if (!query.trim() && !group) {
      status.textContent = 'TYPE A NAME/NORAD ID, OR PICK A GROUP';
      list.innerHTML =
        '<div class="satellite-search-empty">TYPE TO SEARCH, OR FILTER BY GROUP ABOVE</div>';
      return;
    }

    const { results, matchCount } = parts.controls.methods.searchAll(query, {
      group: group || null,
      limit: RESULT_LIMIT,
    });

    if (matchCount === 0) {
      status.textContent = 'NO MATCHES';
      list.innerHTML =
        '<div class="satellite-search-empty">NO SATELLITES MATCH THIS SEARCH</div>';
      return;
    }

    status.textContent =
      matchCount > results.length
        ? `SHOWING ${results.length} OF ${matchCount}`
        : `${matchCount} MATCH${matchCount === 1 ? '' : 'ES'}`;

    list.innerHTML = results
      .map((sat) => {
        const isTracked = sat.noradId === layerState._trackedNorad;
        const altitudeKm = Number.isFinite(sat.altitudeM)
          ? Math.round(sat.altitudeM / 1000).toLocaleString()
          : '—';
        const klass = satelliteClassLabel(sat.group, {
          isIss: sat.noradId === ISS_NORAD,
        });
        return (
          `<button type="button" class="satellite-search-item${isTracked ? ' is-tracked' : ''}" data-satellite-search-id="${sat.noradId}" aria-label="Track ${escapeSatelliteSearchText(sat.name)}" aria-pressed="${isTracked}">` +
          `<span class="satellite-search-copy"><strong>${escapeSatelliteSearchText(sat.name)}</strong>` +
          `<small>NORAD ${sat.noradId} · ${escapeSatelliteSearchText(klass)} · ${altitudeKm} KM</small></span>` +
          `<span class="satellite-search-chevron" aria-hidden="true">${isTracked ? '●' : '›'}</span>` +
          `</button>`
        );
      })
      .join('');
  }

  function scheduleSatelliteSearchRender() {
    if (layerState._satelliteSearchDebounce)
      clearTimeout(layerState._satelliteSearchDebounce);
    layerState._satelliteSearchDebounce = setTimeout(() => {
      layerState._satelliteSearchDebounce = null;
      renderSatelliteSearchResults();
    }, SEARCH_DEBOUNCE_MS);
  }

  function trackSatelliteSearchResult(noradId) {
    const tracked = parts.controls.methods.trackById(noradId, { origin: 'user' });
    if (tracked) renderSatelliteSearchResults();
    return tracked;
  }

  /** Wire the static panel shell already present in index.html — called once from layer init. */
  function createSatellitePanel() {
    if (layerState._satellitePanel || typeof document === 'undefined') return;
    const panel = document.getElementById('satellite-panel');
    if (!panel) return;
    layerState._satellitePanel = panel;

    const input = panel.querySelector('[data-satellite-search-input]');
    const groupSelect = panel.querySelector('[data-satellite-search-group]');
    const list = panel.querySelector('[data-satellite-search-list]');

    input?.addEventListener('input', (event) => {
      layerState._satelliteSearchQuery = event.currentTarget.value;
      scheduleSatelliteSearchRender();
    });

    groupSelect?.addEventListener('change', (event) => {
      layerState._satelliteSearchGroup = event.currentTarget.value;
      renderSatelliteSearchResults();
    });

    list?.addEventListener('click', (event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest('[data-satellite-search-id]')
          : null;
      if (!button) return;
      const noradId = Number(button.dataset.satelliteSearchId);
      if (Number.isFinite(noradId)) trackSatelliteSearchResult(noradId);
    });

    renderSatelliteSearchResults();
  }

  return {
    createSatellitePanel,
    renderSatelliteSearchResults,
    groupLabel,
  };
}

import {
  GEOPOLITICAL_MARKERS,
  createGeopoliticalMarkerImage,
} from '../data/geopoliticalMarkers.js';

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
}

function displayDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString()
    : 'Date unavailable';
}

const PROVIDER_LABELS = Object.freeze({
  gdelt: 'GDELT',
  acled: 'ACLED',
  ucdp: 'UCDP GED',
  'ucdp-candidate': 'UCDP Candidate',
  'hapi-conflict': 'HDX HAPI / ACLED',
  reliefweb: 'ReliefWeb',
});
const GDELT_SEARCH_CATEGORIES = Object.freeze([
  ['all-categories', 'All event categories (CAMEO 1–20)'],
  ['all-conflict', 'All conflict actions (CAMEO 13–20)'],
  ['military-actions', 'Military actions (CAMEO 190–196)'],
  ['threats-coercion', 'Threats and coercion'],
  ['protests', 'Protests'],
  ['show-of-force', 'Show of force'],
  ['diplomatic-actions', 'Diplomatic pressure'],
  ['assaults', 'Assault reports'],
  ['fights', 'Fights'],
  ['mass-violence', 'Mass violence'],
]);

export class GeopoliticalPanel {
  constructor({ documentRef = globalThis.document } = {}) {
    this.document = documentRef;
    this.panel = documentRef?.getElementById?.('geopolitical-panel') || null;
    this.body =
      documentRef?.getElementById?.('geopolitical-panel-body') || null;
    this.popup =
      documentRef?.getElementById?.('geopolitical-map-popup') || null;
    this.layer = null;
    this.unsubscribe = null;
    this.legendOpen = null;
    this._onClick = (event) => {
      const close = event.target?.closest?.('[data-geopolitical-close]');
      if (close) {
        this.layer?.getPanelState?.().onCloseSelection?.();
        return;
      }
      if (event.target?.closest?.('[data-gdelt-search]')) {
        this.layer
          ?.getPanelState?.()
          .onSearchGdeltArea?.(this.gdeltCategory || 'military-actions');
        return;
      }
      if (event.target?.closest?.('[data-gdelt-search-clear]')) {
        this.layer?.getPanelState?.().onClearGdeltSearch?.();
        return;
      }
      if (event.target?.closest?.('[data-ucdp-search]')) {
        this.layer?.getPanelState?.().onSearchUcdpArea?.();
        return;
      }
      if (event.target?.closest?.('[data-ucdp-search-clear]')) {
        this.layer?.getPanelState?.().onClearUcdpSearch?.();
        return;
      }
      const button = event.target?.closest?.('[data-geopolitical-event]');
      if (!button) return;
      this.layer
        ?.getPanelState?.()
        .onSelectEvent?.(button.dataset.geopoliticalEvent);
    };
  }

  mount(layer) {
    if (!this.panel || !this.body || !layer) return;
    this.layer = layer;
    this.body.addEventListener('click', this._onClick);
    this.popup?.addEventListener('click', this._onClick);
    this.unsubscribe = layer.subscribe?.((state) => this.render(state)) || null;
    this.render(layer.getPanelState?.());
  }

  render(state = {}) {
    if (!this.panel || !this.body) return;
    const visible = state.enabled === true;
    this.panel.hidden = !visible;
    this.panel.inert = !visible;
    if (!visible) {
      if (this.popup) {
        this.popup.hidden = true;
        this.popup.inert = true;
        this.popup.innerHTML = '';
      }
      return;
    }
    const providerStatus = (state.providers || [])
      .map((provider) => {
        const label = PROVIDER_LABELS[provider.id] || provider.id;
        const info = provider.count
          ? `${provider.count} · ${esc(provider.status)}${provider.fetchedAt ? ` · ${esc(displayDate(provider.fetchedAt))}` : ''}`
          : esc(provider.error || provider.status);
        return `<div class="geopolitical-provider-status"><strong>${label}</strong><span>${info}</span></div>`;
      })
      .join('');
    const categories = [
      ...new Set((state.events || []).map((item) => item.category)),
    ].sort();
    const currentCategory = this.category || 'all';
    const currentProvider = this.provider || 'all';
    const currentWindow = this.window || 'all';
    const region = this.region || '';
    const categoryOptions = ['all', ...categories]
      .map(
        (category) =>
          `<option value="${esc(category)}"${category === currentCategory ? ' selected' : ''}>${category === 'all' ? 'All categories' : esc(category.replaceAll('-', ' '))}</option>`,
      )
      .join('');
    const searchCategory = this.gdeltCategory || 'military-actions';
    const searchCategoryOptions = GDELT_SEARCH_CATEGORIES.map(
      ([value, label]) =>
        `<option value="${value}"${value === searchCategory ? ' selected' : ''}>${esc(label)}</option>`,
    ).join('');
    const providerOptions = ['all', ...Object.keys(PROVIDER_LABELS)]
      .map(
        (provider) =>
          `<option value="${provider}"${provider === currentProvider ? ' selected' : ''}>${provider === 'all' ? 'All sources' : PROVIDER_LABELS[provider]}</option>`,
      )
      .join('');
    const windowOptions = [
      ['24h', 'Last 24 hours'],
      ['7d', 'Last 7 days'],
      ['30d', 'Last 30 days'],
      ['all', 'All dates'],
    ]
      .map(
        ([key, label]) =>
          `<option value="${key}"${key === currentWindow ? ' selected' : ''}>${label}</option>`,
      )
      .join('');
    const windowMs =
      currentWindow === '24h'
        ? 24 * 60 * 60_000
        : currentWindow === '7d'
          ? 7 * 24 * 60 * 60_000
          : currentWindow === '30d'
            ? 30 * 24 * 60 * 60_000
            : Infinity;
    const cutoff = Date.now() - windowMs;
    const events = (state.events || [])
      .filter((item) => {
        if (currentCategory !== 'all' && item.category !== currentCategory)
          return false;
        if (currentProvider !== 'all' && item.provider !== currentProvider)
          return false;
        const filterDate =
          item.provider === 'gdelt'
            ? item.reportedAt || item.eventAt
            : item.eventAt;
        if (Date.parse(filterDate) < cutoff) return false;
        if (
          region &&
          !`${item.location || ''} ${item.country || ''} ${item.title || ''}`
            .toLowerCase()
            .includes(region.toLowerCase())
        )
          return false;
        return true;
      })
      .slice(0, 80);
    const list = events.length
      ? events
          .map((item) => {
            const mapped =
              Number.isFinite(item.latitude) && Number.isFinite(item.longitude);
            const hasCountryMarker =
              item.provider === 'hapi-conflict'
                ? item.countryScopes?.length > 0
                : item.provider === 'reliefweb' &&
                  item.countryScopes?.some(
                    (scope) =>
                      Number.isFinite(scope.latitude) &&
                      Number.isFinite(scope.longitude),
                  );
            const timeSummary =
              item.provider === 'gdelt'
                ? `Event date ${displayDate(item.eventAt)} · added ${displayDate(item.reportedAt)}`
                : displayDate(item.eventAt);
            return `<button type="button" class="geopolitical-event-row" data-geopolitical-event="${esc(item.id)}"><span class="geopolitical-event-top"><strong>${esc(item.title)}</strong><span>${esc(PROVIDER_LABELS[item.provider] || item.provider)}</span></span><span>${esc(timeSummary)} · ${esc(item.location || 'No specific location')}</span><small>${mapped ? esc(item.locationPrecision) : hasCountryMarker ? 'Included in country marker · aggregate reference point, not an incident location' : 'Not mapped · source has no event coordinates'}</small></button>`;
          })
          .join('')
      : '<p class="geopolitical-empty">No events match this filter. Provider records without event coordinates remain listed and are not assigned invented map positions.</p>';
    const freshness = state.loading
      ? 'Fetching sources…'
      : state.stale
        ? 'Some sources are using cached records.'
        : state.fetchedAt
          ? `Fetched ${esc(displayDate(state.fetchedAt))}`
          : 'Waiting for source data.';
    const search = state.gdeltSearch;
    const searchStatus =
      state.gdeltVisible === false
        ? 'GDELT is hidden from the map and results list.'
        : search?.loading
          ? 'Searching the latest GDELT events…'
          : search?.error
            ? esc(search.error)
            : search
              ? `${search.count} shown of ${search.totalMatches ?? search.count} matching events · ${search.mode === 'global' ? 'global search' : `${search.radiusKm} km area`} · latest 15-minute feed`
              : 'Search GDELT events in the current map area; wider views search globally.';
    const ucdpSearch = state.ucdpSearch;
    const ucdpSearchStatus =
      state.ucdpVisible === false
        ? 'UCDP is hidden from the map and results list.'
        : ucdpSearch?.loading
          ? 'Searching UCDP GED…'
          : ucdpSearch?.error
            ? esc(ucdpSearch.error)
            : ucdpSearch
              ? `${ucdpSearch.count} returned · ${ucdpSearch.mode === 'global' ? 'global search' : `${ucdpSearch.radiusKm} km area`}${ucdpSearch.partial ? ' · search scan capped' : ''} · GED through ${esc(ucdpSearch.dateThrough || '2025-12-31')}`
              : 'Search UCDP GED in the current map area; wider views search globally.';
    this.legendOpen =
      this.body.querySelector('[data-geopolitical-legend]')?.open ??
      this.legendOpen ??
      true;
    const legendRows = Object.entries(GEOPOLITICAL_MARKERS)
      .map(
        ([provider, marker]) =>
          `<div class="geopolitical-legend-row"><img src="${createGeopoliticalMarkerImage(provider)}" alt="" aria-hidden="true" /><span><strong>${esc(marker.label)}</strong><small>${esc(marker.meaning)}</small></span></div>`,
      )
      .join('');
    const legend = `<details class="geopolitical-map-legend" data-geopolitical-legend${this.legendOpen ? ' open' : ''}><summary>MAP SYMBOL KEY</summary><div class="geopolitical-map-legend-list">${legendRows}</div></details>`;
    this.body.innerHTML = `<div class="geopolitical-summary">${events.length} shown · ${(state.events || []).length} source records · ${state.mappedCount || 0} mapped</div>${legend}<label class="geopolitical-provider-toggle"><input type="checkbox" data-gdelt-toggle${state.gdeltVisible === false ? '' : ' checked'} /><span>Show GDELT data</span></label><label class="geopolitical-provider-toggle"><input type="checkbox" data-gdelt-conflict-focus${state.gdeltConflictFocus ? ' checked' : ''} /><span>GDELT conflict focus only</span></label><small class="geopolitical-source-note">Military clash and mass-violence event codes only. GDELT signals are news-derived and unverified.</small><section class="geopolitical-area-search"><strong>GDELT area search</strong><label class="geopolitical-filter-label">Event category <select data-gdelt-search-category${state.gdeltVisible === false ? ' disabled' : ''}>${searchCategoryOptions}</select></label><div class="geopolitical-area-actions"><button type="button" data-gdelt-search${state.gdeltVisible === false || search?.loading ? ' disabled' : ''}>Search current map area</button>${search ? '<button type="button" data-gdelt-search-clear>Clear</button>' : ''}</div><small>${searchStatus}</small></section><label class="geopolitical-provider-toggle"><input type="checkbox" data-ucdp-toggle${state.ucdpVisible === false ? '' : ' checked'} /><span>Show UCDP finalized data</span></label><section class="geopolitical-area-search"><strong>UCDP GED area search</strong><div class="geopolitical-area-actions"><button type="button" data-ucdp-search${state.ucdpVisible === false || ucdpSearch?.loading ? ' disabled' : ''}>Search current map area</button>${ucdpSearch ? '<button type="button" data-ucdp-search-clear>Clear</button>' : ''}</div><small>${ucdpSearchStatus}</small></section><label class="geopolitical-provider-toggle"><input type="checkbox" data-ucdp-candidate-toggle${state.ucdpCandidateVisible === false ? '' : ' checked'} /><span>Show UCDP Candidate Events</span></label><small class="geopolitical-source-note">Monthly preliminary event records; some may change or not appear in the final GED.</small><label class="geopolitical-provider-toggle"><input type="checkbox" data-hapi-toggle${state.hapiVisible === false ? '' : ' checked'} /><span>Show HDX HAPI / ACLED aggregates</span></label><small class="geopolitical-source-note">Monthly public ACLED aggregates, updated weekly. Markers use country reference points; event categories overlap and are not incident locations.</small><div class="geopolitical-filters"><label class="geopolitical-filter-label">Source <select data-geopolitical-provider>${providerOptions}</select></label><label class="geopolitical-filter-label">Category <select data-geopolitical-category>${categoryOptions}</select></label><label class="geopolitical-filter-label">Time <select data-geopolitical-window>${windowOptions}</select></label><label class="geopolitical-filter-label">Region <input type="search" data-geopolitical-region value="${esc(region)}" placeholder="Country or place" /></label></div><div class="geopolitical-provider-status-list">${providerStatus || '<p>Provider status unavailable.</p>'}</div><p class="geopolitical-freshness">${freshness}${state.error ? ` · ${esc(state.error)}` : ''}</p><div class="geopolitical-event-list">${list}</div>`;
    this.body
      .querySelector('[data-geopolitical-legend]')
      ?.addEventListener('toggle', (event) => {
        this.legendOpen = event.currentTarget.open;
      });
    this.body
      .querySelector('[data-gdelt-toggle]')
      ?.addEventListener('change', (event) => {
        this.layer?.getPanelState?.().onToggleGdelt?.(event.target.checked);
      });
    this.body
      .querySelector('[data-ucdp-toggle]')
      ?.addEventListener('change', (event) => {
        this.layer?.getPanelState?.().onToggleUcdp?.(event.target.checked);
      });
    this.body
      .querySelector('[data-ucdp-candidate-toggle]')
      ?.addEventListener('change', (event) => {
        this.layer
          ?.getPanelState?.()
          .onToggleUcdpCandidate?.(event.target.checked);
      });
    this.body
      .querySelector('[data-hapi-toggle]')
      ?.addEventListener('change', (event) => {
        this.layer?.getPanelState?.().onToggleHapi?.(event.target.checked);
      });
    this.body
      .querySelector('[data-gdelt-conflict-focus]')
      ?.addEventListener('change', (event) => {
        this.layer
          ?.getPanelState?.()
          .onToggleGdeltConflictFocus?.(event.target.checked);
      });
    this.body
      .querySelector('[data-gdelt-search-category]')
      ?.addEventListener('change', (event) => {
        this.gdeltCategory = event.target.value;
      });
    const rerender = () => {
      this.provider =
        this.body.querySelector('[data-geopolitical-provider]')?.value || 'all';
      this.category =
        this.body.querySelector('[data-geopolitical-category]')?.value || 'all';
      this.window =
        this.body.querySelector('[data-geopolitical-window]')?.value || 'all';
      this.region =
        this.body.querySelector('[data-geopolitical-region]')?.value || '';
      this.render(this.layer?.getPanelState?.());
    };
    this.body
      .querySelectorAll('select')
      .forEach((control) => control.addEventListener('change', rerender));
    this.body
      .querySelector('[data-geopolitical-region]')
      ?.addEventListener('change', rerender);
    if (this.popup) {
      const selected = state.selected;
      this.popup.hidden = !selected;
      this.popup.inert = !selected;
      this.popup.innerHTML = selected
        ? this.layer.getPopupMarkup?.() || ''
        : '';
      if (selected?.popupPosition) {
        this.popup.style.right = 'auto';
        this.popup.style.bottom = 'auto';
        this.popup.style.left = `${Math.max(8, Math.min(selected.popupPosition.x, (globalThis.innerWidth || 1200) - 360))}px`;
        this.popup.style.top = `${Math.max(8, Math.min(selected.popupPosition.y, (globalThis.innerHeight || 800) - 300))}px`;
      } else if (selected) {
        this.popup.style.left = 'auto';
        this.popup.style.top = 'auto';
        this.popup.style.right = '18px';
        this.popup.style.bottom = '18vh';
      }
    }
  }

  destroy() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.body?.removeEventListener('click', this._onClick);
    this.popup?.removeEventListener('click', this._onClick);
    if (this.panel) {
      this.panel.hidden = true;
      this.panel.inert = true;
    }
    if (this.popup) {
      this.popup.hidden = true;
      this.popup.inert = true;
      this.popup.innerHTML = '';
    }
    this.layer = null;
  }
}

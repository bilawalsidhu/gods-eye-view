import {
  formatAge,
  formatHz,
  repeaterColor,
  repeaterDetails,
  repeaterProvenance,
} from '../sources/hamRepeaters.js';

/** Panel list cap; the layer already sorts nearest first. */
const PANEL_LIST_LIMIT = 60;

function fillSelect(select, entries, current, { disabled = false } = {}) {
  if (!select) return;
  const wanted = entries.map((entry) => `${entry.id}|${entry.label}`).join(',');
  if (select.dataset.options !== wanted) {
    select.innerHTML = '';
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = String(entry.id);
      option.textContent = entry.label;
      select.appendChild(option);
    }
    select.dataset.options = wanted;
  }
  const value = String(current);
  if (select.value !== value) select.value = value;
  select.disabled = disabled;
}

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** One list row: `lead · [dot] CALLSIGN output · tail`, details and provenance beneath. */
function repeaterRow(repeater, { selected, onClick }) {
  const row = document.createElement('div');
  row.className = `ham-repeaters-row${selected ? ' selected' : ''}${repeater.confidence === 'unverified' ? ' unverified' : ''}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(Boolean(selected)));
  row.tabIndex = 0;
  row.dataset.repeaterId = repeater.id;
  row.appendChild(
    span(
      'ham-repeaters-row-lead',
      Number.isFinite(repeater.distanceKm)
        ? `${Math.round(repeater.distanceKm)} km`
        : '',
    ),
  );
  const main = document.createElement('span');
  main.className = 'ham-repeaters-row-main';
  const dot = document.createElement('i');
  dot.className = 'ham-repeaters-kind-dot';
  dot.style.color = repeaterColor(repeater.kind);
  main.appendChild(dot);
  const strong = document.createElement('strong');
  strong.textContent = repeater.callsign;
  main.appendChild(strong);
  main.appendChild(document.createTextNode(` ${formatHz(repeater.outputHz)}`));
  row.appendChild(main);
  row.appendChild(
    span(
      'ham-repeaters-row-tail',
      repeater.kind === 'D-STAR' && repeater.module
        ? `D-STAR ${repeater.module}`
        : repeater.kind,
    ),
  );
  row.appendChild(span('ham-repeaters-row-sub', repeaterDetails(repeater)));
  row.appendChild(
    span('ham-repeaters-row-provenance', repeaterProvenance(repeater)),
  );
  row.addEventListener('click', onClick);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  });
  return row;
}

/** Render Repeaters state without making lifecycle or camera decisions. */
export function renderHamRepeatersState(state) {
  if (this.destroyed || !state || !this._hamRepeatersPanel) return;
  const lifecycle = this.actions.getLifecycle() || null;
  const lifecycleState =
    lifecycle?.lifecycleState || (state.enabled ? 'enabled' : 'disabled');
  const enabled = lifecycle
    ? Boolean(lifecycle.enabled)
    : Boolean(state.enabled);
  const transitioning =
    lifecycleState === 'enabling' || lifecycleState === 'disabling';
  const uncertain = Boolean(lifecycle?.uncertain);
  const interactive = enabled && !transitioning && !uncertain;
  this._state = {
    ...state,
    enabled,
    lifecycleState,
    lifecycleUncertain: uncertain,
  };
  this._hamRepeatersPanel.classList.toggle('radio-enabled', enabled);
  this._hamRepeatersPanel.classList.toggle('lifecycle-uncertain', uncertain);
  this._hamRepeatersLayerState?.classList.toggle('active', enabled);
  if (this._hamRepeatersLayerState) {
    this._hamRepeatersLayerState.textContent = transitioning
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'UNCERTAIN'
        : state.loading
          ? 'SYNC'
          : enabled
            ? `${state.filteredCount}/${state.count}`
            : 'OFF';
  }
  if (this._hamRepeatersEnableBtn) {
    this._hamRepeatersEnableBtn.classList.toggle('active', enabled);
    this._hamRepeatersEnableBtn.setAttribute('aria-pressed', String(enabled));
    this._hamRepeatersEnableBtn.textContent = transitioning
      ? lifecycleState.toUpperCase()
      : uncertain
        ? 'RECONCILE'
        : enabled
          ? 'DISABLE'
          : 'ENABLE';
    this._hamRepeatersEnableBtn.setAttribute(
      'aria-label',
      uncertain
        ? 'Reconcile Repeaters — lifecycle uncertain'
        : `${enabled ? 'Disable' : 'Enable'} Repeaters`,
    );
    this._hamRepeatersEnableBtn.setAttribute(
      'aria-busy',
      String(transitioning),
    );
  }
  this._note(
    this._hamRepeatersSummary,
    enabled
      ? state.loading
        ? 'Loading repeaters…'
        : `${state.filteredCount}/${state.count} repeaters${state.stale ? ' · cached' : ''}${state.partial ? ' · partial' : ''}`
      : 'Repeaters off — LOAD HERE switches it on',
    { error: Boolean(state.error) && !state.count },
  );
  fillSelect(
    this._hamRepeatersBand,
    state.filters?.bands || [{ id: 'all', label: 'All bands' }],
    state.filter?.band || 'all',
    { disabled: !interactive },
  );
  fillSelect(
    this._hamRepeatersKind,
    state.filters?.kinds || [{ id: 'all', label: 'All repeaters' }],
    state.filter?.kind || 'all',
    { disabled: !interactive },
  );
  if (this._hamRepeatersLoadBtn)
    this._hamRepeatersLoadBtn.disabled = transitioning || uncertain;
  const areaParts = [];
  if (state.areaLabel) areaParts.push(state.areaLabel);
  if (state.lastLoad?.count !== undefined && state.lastLoad?.at)
    areaParts.push(
      `${state.lastLoad.count} loaded ${formatAge(state.lastLoad.at)} ago`,
    );
  if (
    enabled &&
    state.gate &&
    !state.gate.withinGate &&
    Number.isFinite(state.gate.heightM)
  )
    areaParts.push(
      `auto-load below ${Math.round(state.gate.gateM / 1000)} km (now ${Math.round(state.gate.heightM / 1000)} km)`,
    );
  if (state.partial) {
    const failed = Object.keys(state.errors || {}).join(', ');
    areaParts.push(`${failed || 'one feed'} did not answer`);
  }
  if (state.error) areaParts.push(state.error);
  this._note(this._hamRepeatersArea, areaParts.join(' · '), {
    error: Boolean(state.error),
  });
  const list = this._hamRepeatersList;
  if (!list) return;
  const rows = (state.items || []).slice(0, PANEL_LIST_LIMIT).map((repeater) =>
    repeaterRow(repeater, {
      selected: repeater.id === state.selectedId,
      onClick: () =>
        this.layer.select(repeater.id, { flyTo: true, origin: 'user' }),
    }),
  );
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'ham-repeaters-list-empty';
    empty.textContent = enabled
      ? state.loading
        ? 'Loading…'
        : state.area
          ? 'No repeaters in this area.'
          : 'Fly below 1500 km or press LOAD HERE.'
      : 'Enable Repeaters (or press LOAD HERE) for FM and D-STAR repeaters around the view.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...rows);
}

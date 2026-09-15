import {
  FIELD,
  OVERLAY,
  REFRESH_CHOICES,
  WEATHER_LAYER_SPECS,
  codesToIds,
  defaultActiveCodes,
  idsToCodes,
} from '../layers/weather/policy.js';

/**
 * The Weather panel: which layers draw, and when they are allowed to cost.
 *
 * Every tile is billed against a monthly allowance, and the bill scales with
 * how many layers are on rather than with how often they refresh — each
 * enabled layer re-fetches on every camera move. So the panel is built around
 * making that visible: layers are opted into one at a time, refresh is a
 * button unless someone asks for a timer, and the running total sits beside
 * the controls that move it.
 *
 * Overlays are sparse and stack freely. Fields paint every pixel, so exactly
 * one may be on; the group is a radio group for that reason, and the layer
 * enforces the same rule so a hand-written share link cannot bypass it.
 */
export function bindWeatherControls({ elements, actions }) {
  const removers = [];
  const listen = (element, type, handler) => {
    if (!element) return;
    element.addEventListener(type, handler);
    removers.push(() => element.removeEventListener(type, handler));
  };

  const overlays = WEATHER_LAYER_SPECS.filter((spec) => spec.group === OVERLAY);
  const fields = WEATHER_LAYER_SPECS.filter((spec) => spec.group === FIELD);
  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();

  const describe = (spec) => {
    const parts = [spec.detail];
    if (spec.cadence) parts.push(`Updates ${spec.cadence}`);
    if (spec.coverage) parts.push(spec.coverage.note);
    if (spec.forecast) parts.push('Forecast, not an observation');
    return parts.join(' · ');
  };

  function optionButton(spec, role) {
    const button = document.createElement('button');
    button.type = 'button';
    // The rail's existing chip component, so state, hover and focus match
    // every other chip in the app.
    button.className = 'data-toggle-chip weather-chip';
    button.dataset.layerCode = spec.code;
    button.title = describe(spec);
    if (role === 'radio') {
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
    } else {
      button.setAttribute('aria-pressed', 'false');
    }

    const label = document.createElement('span');
    label.className = 'weather-chip-label';
    label.textContent = spec.label;
    button.appendChild(label);

    // Several layers only have data over part of the world. Saying so on the
    // row is the difference between "switched on and quiet" and "broken".
    if (spec.coverage) {
      const tag = document.createElement('span');
      tag.className = 'weather-chip-tag';
      tag.textContent = spec.coverage.tag;
      button.appendChild(tag);
    }
    // A forecast is labelled wherever it appears, so it can never be mistaken
    // for an observation of now.
    if (spec.forecast) {
      const tag = document.createElement('span');
      tag.className = 'weather-chip-tag';
      tag.textContent = 'FCST';
      button.appendChild(tag);
    }

    buttons.set(spec.code, button);
    return button;
  }

  const render = (container, list, role) => {
    if (!container) return;
    container.textContent = '';
    for (const spec of list) container.appendChild(optionButton(spec, role));
  };

  render(elements.overlays, overlays, 'checkbox');
  render(elements.fields, fields, 'radio');

  if (elements.interval) {
    elements.interval.textContent = '';
    for (const choice of REFRESH_CHOICES) {
      const option = document.createElement('option');
      option.value = choice.code;
      option.textContent = `Every ${choice.label}`;
      elements.interval.appendChild(option);
    }
  }

  /** Current selection, as the packed code string everything else speaks. */
  let selection = '';

  const toggle = (code) => {
    const spec = WEATHER_LAYER_SPECS.find((entry) => entry.code === code);
    if (!spec) return;
    const active = codesToIds(selection);
    const on = active.includes(spec.id);
    let next;
    if (spec.group === FIELD) {
      // Picking a field replaces whichever field was on; picking the one
      // already on turns it off, so "no field" stays reachable.
      next = active.filter(
        (id) =>
          WEATHER_LAYER_SPECS.find((entry) => entry.id === id)?.group !== FIELD,
      );
      if (!on) next.push(spec.id);
    } else {
      next = on ? active.filter((id) => id !== spec.id) : [...active, spec.id];
    }
    actions.setLayers(idsToCodes(next));
  };

  listen(elements.overlays, 'click', (event) => {
    const button = event.target?.closest?.('.data-toggle-chip');
    if (button) toggle(button.dataset.layerCode);
  });
  listen(elements.fields, 'click', (event) => {
    const button = event.target?.closest?.('.data-toggle-chip');
    if (button) toggle(button.dataset.layerCode);
  });
  listen(elements.refresh, 'click', () => actions.refreshNow());
  listen(elements.auto, 'click', () =>
    actions.setAuto(elements.auto.getAttribute('aria-pressed') !== 'true'),
  );
  listen(elements.interval, 'change', () =>
    actions.setInterval(elements.interval.value),
  );

  return {
    /**
     * Paint the panel from layer state.
     *
     * @param {{layers:string, auto:boolean, every:string}} params - Layer params.
     * @param {{hasKey:boolean, monthCount:number, budget:number}|null} status -
     *   Proxy status, or null while it is unknown.
     */
    sync(params = {}, status = null) {
      // Before the layer is registered there are no params to read, and an
      // empty panel would misreport the default selection as "everything off".
      selection =
        typeof params.layers === 'string'
          ? params.layers
          : defaultActiveCodes();
      const active = new Set(codesToIds(selection));
      for (const spec of WEATHER_LAYER_SPECS) {
        const button = buttons.get(spec.code);
        if (!button) continue;
        const on = active.has(spec.id);
        button.classList.toggle('active', on);
        if (button.getAttribute('role') === 'radio')
          button.setAttribute('aria-checked', String(on));
        else button.setAttribute('aria-pressed', String(on));
      }

      const auto = params.auto === true;
      if (elements.auto) {
        elements.auto.setAttribute('aria-pressed', String(auto));
        elements.auto.classList.toggle('active', auto);
      }
      if (elements.interval) {
        elements.interval.disabled = !auto;
        if (typeof params.every === 'string')
          elements.interval.value = params.every;
      }

      // Without a key nothing here can draw, so say that once rather than
      // letting every row look switched on and silent.
      const keyless = status ? status.hasKey === false : false;
      if (elements.unavailable) elements.unavailable.hidden = !keyless;
      if (elements.refresh) elements.refresh.disabled = keyless;

      if (elements.budget) {
        elements.budget.textContent =
          status && Number.isFinite(status.monthCount)
            ? `${status.monthCount.toLocaleString()} of ${status.budget.toLocaleString()} tiles this month`
            : ' ';
      }
    },

    destroy() {
      for (const remove of removers.splice(0)) remove();
      buttons.clear();
    },
  };
}

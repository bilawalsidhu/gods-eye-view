import {
  CITS_BUCKET_CSS,
  CITS_KIND_GROUPS,
  CITS_RANGE_SETTINGS,
  CITS_UNKNOWN_CSS,
} from './model.js';

/** Swatch colour per panel group (the dot palette's typical colour). */
const GROUP_SWATCH = Object.freeze({
  car: CITS_UNKNOWN_CSS,
  bus: CITS_UNKNOWN_CSS,
  tram: '#FFC24A',
  other: CITS_UNKNOWN_CSS,
  traffic_light: CITS_BUCKET_CSS.free,
  rsu: 'rgba(255,255,255,0.45)',
  trailer: CITS_BUCKET_CSS.slow,
  hazard: CITS_BUCKET_CSS.jam,
});

function sliderToValue(spec, position) {
  if (!spec.log) return Number(position);
  const t = Number(position) / 1000;
  const value = spec.min * (spec.max / spec.min) ** t;
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

function valueToSlider(spec, value) {
  if (!spec.log) return value;
  return Math.round(
    (Math.log(value / spec.min) / Math.log(spec.max / spec.min)) * 1000,
  );
}

function formatValue(spec, value) {
  return spec.unit === '×' ? `${value.toFixed(1)}×` : `${value} ${spec.unit}`;
}

/**
 * Bind the C-ITS settings panel in the right rail (`#cits-panel`).
 * Controls are built once; later renders only update values and counts so a
 * slider is never rebuilt under the pointer.
 * @param {{documentRef?:Document, onChange:function(object):void, onReset:function():void}} options
 */
export function createCitsPanel({
  documentRef = globalThis.document,
  onChange,
  onReset,
}) {
  const panel = documentRef?.getElementById?.('cits-panel');
  const body = documentRef?.getElementById?.('cits-panel-body');
  const count = documentRef?.getElementById?.('cits-panel-count');
  if (!panel || !body) {
    return { show() {}, hide() {}, render() {}, destroy() {} };
  }
  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const status = el('div', 'cits-status', '');
  const ranges = new Map();
  const kinds = new Map();

  function build() {
    body.replaceChildren();
    body.append(status);

    body.append(el('div', 'cits-section-title', 'Visibility'));
    for (const spec of CITS_RANGE_SETTINGS) {
      const row = el('label', 'cits-range');
      const name = el('span', '', spec.label);
      const output = el('output', '', '');
      const input = el('input');
      input.type = 'range';
      input.min = spec.log ? '0' : String(spec.min);
      input.max = spec.log ? '1000' : String(spec.max);
      input.step = spec.log ? '1' : String(spec.step);
      input.setAttribute('aria-label', spec.label);
      input.addEventListener('input', () => {
        const value = sliderToValue(spec, input.value);
        output.textContent = formatValue(spec, value);
        onChange({ [spec.id]: value });
      });
      row.append(name, output, input);
      body.append(row);
      ranges.set(spec.id, { spec, input, output });
    }

    body.append(el('div', 'cits-section-title', 'Show'));
    const grid = el('div', 'cits-kinds');
    const groups = [
      ...CITS_KIND_GROUPS,
      { id: 'lanes', label: 'Signal lanes' },
    ];
    for (const group of groups) {
      const button = el('button', 'cits-kind');
      button.type = 'button';
      const swatch = el('span', 'cits-swatch');
      swatch.style.background =
        group.id === 'lanes' ? CITS_BUCKET_CSS.jam : GROUP_SWATCH[group.id];
      const label = el('span', '', group.label);
      const number = el('span', 'cits-kind-count', '');
      button.append(swatch, label, number);
      button.addEventListener('click', () => {
        const on = button.getAttribute('aria-pressed') !== 'true';
        onChange(
          group.id === 'lanes' ? { lanes: on } : { groups: { [group.id]: on } },
        );
      });
      grid.append(button);
      kinds.set(group.id, { button, number });
    }
    body.append(grid);

    const reset = el('button', 'scene-btn cits-reset', 'RESET');
    reset.type = 'button';
    reset.addEventListener('click', () => onReset());
    body.append(reset);
  }

  build();

  return {
    show() {
      panel.hidden = false;
    },
    hide() {
      panel.hidden = true;
    },
    /** Reflect settings and live counts. */
    render(settings, stats = {}) {
      for (const { spec, input, output } of ranges.values()) {
        const value = settings[spec.id];
        if (documentRef.activeElement !== input)
          input.value = String(valueToSlider(spec, value));
        output.textContent = formatValue(spec, value);
      }
      const byGroup = stats.byGroup || {};
      for (const [id, { button, number }] of kinds) {
        const on = id === 'lanes' ? settings.lanes : settings.groups[id];
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        number.textContent =
          id === 'lanes'
            ? String(stats.intersections ?? 0)
            : String(byGroup[id] ?? 0);
      }
      const total = Object.values(byGroup).reduce((a, b) => a + b, 0);
      if (count) count.textContent = String(total);
      const upstream = stats.upstream?.receivedBytes
        ? ` · ${(stats.upstream.receivedBytes / 1e6).toFixed(0)} MB received`
        : '';
      status.textContent = `${stats.mode === 'full' ? 'HIGH BANDWIDTH' : 'TILED'} · ${stats.status ? String(stats.status).toUpperCase() : 'IDLE'}${upstream}`;
    },
    destroy() {
      panel.hidden = true;
      body.replaceChildren();
    },
  };
}

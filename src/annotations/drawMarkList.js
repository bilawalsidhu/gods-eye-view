/**
 * The shapes drawn by hand, listed under Draw the way Import lists its files:
 * one row per shape with its colour, its name, and show/hide, fly-to and
 * remove. The name is edited in place and the colour picked from the row, so
 * a shape is labelled and coloured after it is drawn, when it can be seen.
 *
 * The board is the annotation engine's: this list only reads `list()`, asks
 * for changes through `remove`, `setHidden`, `frame` and `restyle`, and
 * re-renders on `onChange`. Voice marks are not listed; only `manual` ones.
 */
import { msg, t } from '../i18n/index.js';

export const DRAW_COLORS = Object.freeze([
  'primary',
  'amber',
  'cyan',
  'green',
  'red',
]);
/** The swatch for each colour, matching the preview and the drawn shape. */
export const DRAW_COLOR_CSS = Object.freeze({
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
});
const COLOR_NAMES = Object.freeze({
  primary: msg('Primary'),
  amber: msg('Amber'),
  cyan: msg('Cyan'),
  green: msg('Green'),
  red: msg('Red'),
});
const SHAPE_NAMES = Object.freeze({
  area: msg('Area'),
  route: msg('Line'),
  pin: msg('Pin'),
});

/** What a row calls a shape that has no name of its own. */
export function drawMarkFallbackName(mark) {
  const shape = t(SHAPE_NAMES[mark?.type] || SHAPE_NAMES.pin);
  // An unnamed line's label is its length; keep it, it is the useful part.
  return mark?.type === 'route' && !mark.name && mark.label
    ? `${shape} · ${mark.label}`
    : shape;
}

/**
 * @param {{
 *   listEl: HTMLElement,
 *   annotations: {list: Function, remove: Function, setHidden: Function,
 *     frame: Function, restyle: Function, onChange?: Function},
 *   listen: (target: EventTarget, type: string, listener: Function, options?: object) => void,
 * }} deps
 * @returns {{render: Function, marks: Function, destroy: Function}}
 */
export function createDrawMarkList({ listEl, annotations, listen }) {
  const doc = listEl.ownerDocument;
  let destroyed = false;
  let picking = null; // the id whose colour picker is open
  /** @type {Map<string, object>} each listed mark's row nodes */
  const rows = new Map();
  let rendering = false;
  let rerender = false;

  const marks = () =>
    (annotations.list?.() || []).filter((mark) => mark?.manual === true);
  const find = (id) => marks().find((mark) => mark.id === id) || null;

  function actionButton(icon, control) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'geo-import-action';
    button.dataset.control = control;
    const glyph = doc.createElement('span');
    glyph.className = 'material-symbols-outlined';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = icon;
    button.append(glyph);
    return button;
  }

  function setLabel(node, label) {
    node.title = label;
    node.setAttribute('aria-label', label);
  }

  function colorPicker() {
    const picker = doc.createElement('div');
    picker.className = 'draw-colors draw-mark-colors';
    picker.dataset.control = 'picker';
    picker.setAttribute('role', 'radiogroup');
    for (const color of DRAW_COLORS) {
      const swatch = doc.createElement('button');
      swatch.type = 'button';
      swatch.className = 'draw-color';
      swatch.dataset.color = color;
      swatch.dataset.control = `color-${color}`;
      swatch.setAttribute('role', 'radio');
      setLabel(swatch, t(COLOR_NAMES[color]));
      picker.append(swatch);
    }
    return picker;
  }

  const label = (mark) => mark.name || drawMarkFallbackName(mark);

  /** One row's nodes, built once and kept while its mark is on the board. */
  function createRow(id) {
    const row = doc.createElement('li');
    row.className = 'geo-import-row draw-mark-row';
    row.dataset.markId = id;

    const swatch = doc.createElement('button');
    swatch.type = 'button';
    swatch.className = 'geo-import-swatch draw-mark-swatch';
    swatch.dataset.control = 'swatch';

    // textContent and value only, never markup: the name is typed text.
    const name = doc.createElement('input');
    name.type = 'text';
    name.className = 'geo-import-name draw-mark-name';
    name.dataset.control = 'name';
    name.maxLength = 120;
    name.autocomplete = 'off';
    name.spellcheck = false;

    const toggle = actionButton('visibility', 'toggle');
    const fly = actionButton('my_location', 'fly');
    const remove = actionButton('close', 'remove');
    row.append(swatch, name, toggle, fly, remove);
    return { row, swatch, name, toggle, fly, remove, picker: null };
  }

  function updateRow(nodes, mark) {
    const { row, swatch, name, toggle, fly, remove } = nodes;
    const title = label(mark);
    row.classList.toggle('hidden-mark', Boolean(mark.hidden));
    swatch.style.background = DRAW_COLOR_CSS[mark.color] || '';
    setLabel(swatch, t('Change the colour of {name}', { name: title }));
    swatch.setAttribute('aria-expanded', String(picking === mark.id));
    // A name being typed is the person's draft: a board change elsewhere
    // must not overwrite it.
    if (doc.activeElement !== name) name.value = mark.name || '';
    name.placeholder = drawMarkFallbackName(mark);
    name.setAttribute('aria-label', t('Name of {name}', { name: title }));
    const visible = !mark.hidden;
    toggle.children[0].textContent = visible ? 'visibility' : 'visibility_off';
    setLabel(
      toggle,
      visible
        ? t('Hide {name}', { name: title })
        : t('Show {name}', { name: title }),
    );
    toggle.setAttribute('aria-pressed', String(visible));
    setLabel(fly, t('Fly to {name}', { name: title }));
    setLabel(remove, t('Remove {name}', { name: title }));

    if (picking === mark.id) {
      nodes.picker ||= colorPicker();
      nodes.picker.setAttribute(
        'aria-label',
        t('Colour of {name}', { name: title }),
      );
      for (const button of nodes.picker.children) {
        const on = button.dataset.color === mark.color;
        button.classList.toggle('active', on);
        button.setAttribute('aria-checked', String(on));
      }
      if (nodes.picker.parentNode !== row) row.append(nodes.picker);
    } else if (nodes.picker) {
      nodes.picker.remove();
      nodes.picker = null;
    }
  }

  /**
   * Bring the rows in line with the board. Rows are updated in place, never
   * rebuilt: a rebuild would detach the button under a click that is half
   * done, and the name field someone is typing in.
   */
  function render() {
    if (destroyed) return;
    if (rendering) {
      rerender = true;
      return;
    }
    rendering = true;
    try {
      do {
        rerender = false;
        reconcile();
      } while (rerender && !destroyed);
    } finally {
      rendering = false;
    }
  }

  function reconcile() {
    const list = marks();
    if (picking && !list.some((mark) => mark.id === picking)) picking = null;
    const live = new Set(list.map((mark) => mark.id));
    for (const [id, nodes] of rows) {
      if (live.has(id)) continue;
      nodes.row.remove();
      rows.delete(id);
    }
    list.forEach((mark, index) => {
      let nodes = rows.get(mark.id);
      if (!nodes) {
        nodes = createRow(mark.id);
        rows.set(mark.id, nodes);
      }
      updateRow(nodes, mark);
      // Move a row only when it is out of place, so a focused one stays put.
      if (listEl.children[index] !== nodes.row)
        listEl.insertBefore(nodes.row, listEl.children[index] || null);
    });
    listEl.classList.toggle('visible', list.length > 0);
  }

  const rowId = (node) => node?.closest?.('[data-mark-id]')?.dataset.markId;

  /** Commit a typed name; an unchanged one costs nothing. */
  function commitName(input) {
    const id = rowId(input);
    const mark = id && find(id);
    if (!mark) return;
    const next = input.value.trim();
    input.value = next;
    if (next === (mark.name || '')) return;
    annotations.restyle(id, { name: next });
  }

  /** Close a row's colour picker and give focus back to its swatch. */
  function closePicker(id) {
    picking = null;
    render();
    rows.get(id)?.swatch.focus?.();
  }

  listen(listEl, 'click', (event) => {
    const control = event.target?.closest?.('[data-control]');
    const id = rowId(control);
    if (!control || !id) return;
    const kind = control.dataset.control;
    if (kind === 'swatch') {
      picking = picking === id ? null : id;
      render();
    } else if (kind.startsWith('color-')) {
      const color = control.dataset.color;
      picking = null;
      if (find(id)?.color !== color) annotations.restyle(id, { color });
      closePicker(id);
    } else if (kind === 'toggle') annotations.setHidden(id, !find(id)?.hidden);
    else if (kind === 'fly') annotations.frame(id);
    else if (kind === 'remove') annotations.remove(id);
  });
  listen(listEl, 'keydown', (event) => {
    const input = event.target;
    if (event.key === 'Escape' && picking && rowId(input) === picking) {
      // Escape closes the picker; it must not also leave Draw.
      event.preventDefault();
      event.stopPropagation();
      closePicker(picking);
      return;
    }
    if (input?.dataset?.control !== 'name') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitName(input);
      input.blur?.();
    } else if (event.key === 'Escape') {
      // Escape undoes the edit; it must not also leave Draw or cancel a shape.
      event.preventDefault();
      event.stopPropagation();
      input.value = find(rowId(input))?.name || '';
      input.blur?.();
    }
  });
  listen(listEl, 'focusout', (event) => {
    if (event.target?.dataset?.control === 'name') commitName(event.target);
  });

  const unsubscribe = annotations.onChange?.(render) || (() => {});
  render();

  return {
    render,
    marks,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      rows.clear();
      listEl.replaceChildren();
      listEl.classList.remove('visible');
    },
  };
}

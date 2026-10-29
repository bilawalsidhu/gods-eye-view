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

  const marks = () =>
    (annotations.list?.() || []).filter((mark) => mark?.manual === true);
  const find = (id) => marks().find((mark) => mark.id === id) || null;

  /** Which row control has focus, so a re-render can give it back. */
  function focusedControl() {
    const active = doc.activeElement;
    if (!active || !listEl.contains?.(active)) return null;
    const row = active.closest?.('[data-mark-id]');
    return row
      ? { id: row.dataset.markId, control: active.dataset?.control }
      : null;
  }

  function restoreFocus(was) {
    if (!was) return;
    const row = [...listEl.querySelectorAll('[data-mark-id]')].find(
      (node) => node.dataset.markId === was.id,
    );
    row?.querySelector?.(`[data-control="${was.control}"]`)?.focus?.();
  }

  function actionButton(icon, label, control) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'geo-import-action';
    button.dataset.control = control;
    button.title = label;
    button.setAttribute('aria-label', label);
    const glyph = doc.createElement('span');
    glyph.className = 'material-symbols-outlined';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = icon;
    button.append(glyph);
    return button;
  }

  function colorPicker(mark) {
    const picker = doc.createElement('div');
    picker.className = 'draw-colors draw-mark-colors';
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute(
      'aria-label',
      t('Colour of {name}', { name: label(mark) }),
    );
    for (const color of DRAW_COLORS) {
      const swatch = doc.createElement('button');
      swatch.type = 'button';
      swatch.className = `draw-color${color === mark.color ? ' active' : ''}`;
      swatch.dataset.color = color;
      swatch.dataset.control = `color-${color}`;
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-checked', String(color === mark.color));
      const name = t(COLOR_NAMES[color]);
      swatch.title = name;
      swatch.setAttribute('aria-label', name);
      picker.append(swatch);
    }
    return picker;
  }

  const label = (mark) => mark.name || drawMarkFallbackName(mark);

  function render() {
    if (destroyed) return;
    const keep = focusedControl();
    const list = marks();
    if (picking && !list.some((mark) => mark.id === picking)) picking = null;
    listEl.replaceChildren(
      ...list.map((mark) => {
        const row = doc.createElement('li');
        row.className = 'geo-import-row draw-mark-row';
        row.dataset.markId = mark.id;
        if (mark.hidden) row.classList.add('hidden-mark');

        const swatch = doc.createElement('button');
        swatch.type = 'button';
        swatch.className = 'geo-import-swatch draw-mark-swatch';
        swatch.dataset.control = 'swatch';
        swatch.style.background = DRAW_COLOR_CSS[mark.color] || '';
        const swatchLabel = t('Change the colour of {name}', {
          name: label(mark),
        });
        swatch.title = swatchLabel;
        swatch.setAttribute('aria-label', swatchLabel);
        swatch.setAttribute('aria-expanded', String(picking === mark.id));

        // textContent and value only, never markup: the name is typed text.
        const name = doc.createElement('input');
        name.type = 'text';
        name.className = 'geo-import-name draw-mark-name';
        name.dataset.control = 'name';
        name.maxLength = 120;
        name.autocomplete = 'off';
        name.spellcheck = false;
        name.value = mark.name || '';
        name.placeholder = drawMarkFallbackName(mark);
        name.setAttribute(
          'aria-label',
          t('Name of {name}', { name: label(mark) }),
        );

        const visible = !mark.hidden;
        const toggle = actionButton(
          visible ? 'visibility' : 'visibility_off',
          visible
            ? t('Hide {name}', { name: label(mark) })
            : t('Show {name}', { name: label(mark) }),
          'toggle',
        );
        toggle.setAttribute('aria-pressed', String(visible));
        row.append(
          swatch,
          name,
          toggle,
          actionButton(
            'my_location',
            t('Fly to {name}', { name: label(mark) }),
            'fly',
          ),
          actionButton(
            'close',
            t('Remove {name}', { name: label(mark) }),
            'remove',
          ),
        );
        if (picking === mark.id) row.append(colorPicker(mark));
        return row;
      }),
    );
    listEl.classList.toggle('visible', list.length > 0);
    restoreFocus(keep);
  }

  const rowId = (node) => node?.closest?.('[data-mark-id]')?.dataset.markId;

  /** Commit a typed name; an unchanged one costs nothing. */
  function commitName(input) {
    const id = rowId(input);
    const mark = id && find(id);
    if (!mark) return;
    const next = input.value.trim();
    if (next === (mark.name || '')) return;
    annotations.restyle(id, { name: next });
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
      picking = null;
      annotations.restyle(id, { color: control.dataset.color });
      render();
    } else if (kind === 'toggle') annotations.setHidden(id, !find(id)?.hidden);
    else if (kind === 'fly') annotations.frame(id);
    else if (kind === 'remove') annotations.remove(id);
  });
  listen(listEl, 'keydown', (event) => {
    const input = event.target;
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
      listEl.replaceChildren();
      listEl.classList.remove('visible');
    },
  };
}

/**
 * Command palette.
 *
 * Follows the ARIA combobox pattern: the text field keeps focus for the whole
 * interaction and points at the active row through `aria-activedescendant`,
 * so typing and navigating never fight over the caret. Rows are rebuilt from
 * live state on every open — see `buildCommands` — and the palette owns no
 * application state of its own.
 */

import { filterCommands } from './commands.js';

const MAX_ROWS = 40;

/**
 * @param {object} options
 * @param {Document} [options.documentRef]
 * @param {() => Array<object>} options.collectCommands Live command registry.
 * @param {(command: object) => void} [options.onRun] Notified after a run.
 * @returns {{open:Function, close:Function, isOpen:Function, destroy:Function}}
 */
export function createCommandPalette({
  documentRef = document,
  collectCommands,
  onRun,
} = {}) {
  const root = documentRef.getElementById('gev-console-palette');
  const scrim = documentRef.getElementById('gev-console-palette-scrim');
  const input = documentRef.getElementById('gev-console-palette-input');
  const list = documentRef.getElementById('gev-console-palette-list');
  const count = documentRef.getElementById('gev-console-palette-count');
  if (!root || !input || !list) {
    return {
      open() {},
      close() {},
      isOpen: () => false,
      destroy() {},
    };
  }

  const removers = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener(type, handler, options);
    removers.push(() => target?.removeEventListener(type, handler, options));
  };

  let commands = [];
  let visible = [];
  let active = 0;
  let restoreFocus = null;

  function renderRows() {
    list.textContent = '';
    if (!visible.length) {
      const empty = documentRef.createElement('div');
      empty.className = 'gc-palette-empty';
      empty.textContent = 'NO MATCHING COMMAND';
      list.appendChild(empty);
      return;
    }
    const fragment = documentRef.createDocumentFragment();
    let previousSection = '';
    visible.forEach((command, index) => {
      if (command.section && command.section !== previousSection) {
        const heading = documentRef.createElement('div');
        heading.className = 'gc-palette-section';
        heading.textContent = command.section;
        fragment.appendChild(heading);
        previousSection = command.section;
      }
      const row = documentRef.createElement('div');
      row.className = 'gc-row';
      row.id = `gev-console-option-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === active));
      row.dataset.index = String(index);
      if (command.disabled) row.dataset.disabled = 'true';

      const main = documentRef.createElement('span');
      main.className = 'gc-row-main';
      const title = documentRef.createElement('span');
      title.className = 'gc-row-title';
      title.textContent = command.title || command.id;
      main.appendChild(title);
      if (command.subtitle) {
        const subtitle = documentRef.createElement('span');
        subtitle.className = 'gc-row-sub';
        subtitle.textContent = command.subtitle;
        main.appendChild(subtitle);
      }
      row.appendChild(main);

      const badge = command.state || command.hint;
      if (badge) {
        const state = documentRef.createElement('span');
        state.className = command.state ? 'gc-row-state' : 'gc-row-hint';
        if (command.state) state.dataset.value = command.state;
        state.textContent = badge;
        row.appendChild(state);
      }
      fragment.appendChild(row);
    });
    list.appendChild(fragment);
    syncActive();
  }

  function syncActive() {
    const rows = list.querySelectorAll('.gc-row');
    rows.forEach((row) => {
      const isActive = Number(row.dataset.index) === active;
      row.setAttribute('aria-selected', String(isActive));
      row.classList.toggle('is-active', isActive);
      if (isActive) row.scrollIntoView({ block: 'nearest' });
    });
    const activeRow = rows[active];
    if (activeRow) input.setAttribute('aria-activedescendant', activeRow.id);
    else input.removeAttribute('aria-activedescendant');
  }

  function refresh() {
    visible = filterCommands(commands, input.value, MAX_ROWS);
    active = 0;
    renderRows();
    if (count) {
      const total = visible.length;
      count.textContent = `${total} ${total === 1 ? 'COMMAND' : 'COMMANDS'}`;
    }
  }

  function move(delta) {
    if (!visible.length) return;
    active = (active + delta + visible.length) % visible.length;
    syncActive();
  }

  function runActive() {
    const command = visible[active];
    if (!command || command.disabled) return;
    close();
    try {
      command.run?.();
    } catch (error) {
      console.warn('[Console] command failed:', error);
    }
    onRun?.(command);
  }

  function open() {
    if (!root.hidden) return;
    restoreFocus =
      documentRef.activeElement instanceof HTMLElement
        ? documentRef.activeElement
        : null;
    commands = collectCommands?.() || [];
    input.value = '';
    root.hidden = false;
    root.classList.add('is-open');
    refresh();
    input.focus({ preventScroll: true });
  }

  function close() {
    if (root.hidden) return;
    root.classList.remove('is-open');
    root.hidden = true;
    input.removeAttribute('aria-activedescendant');
    restoreFocus?.focus?.({ preventScroll: true });
    restoreFocus = null;
  }

  listen(input, 'input', refresh);
  listen(input, 'keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      active = 0;
      syncActive();
    } else if (event.key === 'End') {
      event.preventDefault();
      active = Math.max(0, visible.length - 1);
      syncActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runActive();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      // The palette is modal: keep the caret inside rather than handing focus
      // to the chrome behind the scrim.
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  });
  listen(list, 'pointermove', (event) => {
    const row = event.target?.closest?.('.gc-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (Number.isInteger(index) && index !== active) {
      active = index;
      syncActive();
    }
  });
  listen(list, 'click', (event) => {
    const row = event.target?.closest?.('.gc-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!Number.isInteger(index)) return;
    active = index;
    runActive();
  });
  listen(scrim, 'click', close);

  return {
    open,
    close,
    isOpen: () => !root.hidden,
    destroy() {
      close();
      for (const remove of removers.splice(0)) remove();
    },
  };
}

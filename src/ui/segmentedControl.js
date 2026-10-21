const STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Pure value navigation, also usable by a future template-based view. */
export function nextSegmentValue(values, value, key, { homeEnd = true } = {}) {
  if (!values.length) return undefined;
  if (homeEnd && key === 'Home') return values[0];
  if (homeEnd && key === 'End') return values.at(-1);
  const step = STEPS[key];
  if (!step) return undefined;
  return values[(values.indexOf(value) + step + values.length) % values.length];
}

/** Paint controlled selection without emitting changes or moving focus. */
export function syncSegmentedControl(
  buttons,
  value,
  { valueOf, activeClass = 'active', rovingFocus = false } = {},
) {
  for (const button of buttons || []) {
    if (!button) continue;
    const selected = valueOf(button) === value;
    if (button.classList.contains(activeClass) !== selected)
      button.classList.toggle(activeClass, selected);
    const set = (name, content) => {
      if (button.getAttribute?.(name) !== content)
        button.setAttribute(name, content);
    };
    set('aria-checked', String(selected));
    if (rovingFocus) set('tabindex', selected ? '0' : '-1');
  }
}

/**
 * Controlled segmented-selector DOM adapter. Feature owners supply values and
 * receive changes; rendering a restored value never triggers the callback.
 * `keyboard` retains each existing group's policy: none, arrows, or radio
 * (arrows plus Home/End). Pointer and native Enter/Space share the click path.
 * An injected listener owner keeps the feature's existing teardown boundary.
 * @param {object} options
 * @param {Iterable<HTMLButtonElement>} options.buttons
 * @param {Function} options.valueOf Maps a button to the feature's value.
 * @param {Function} options.onChange Receives value and originating button.
 * @param {'none'|'arrows'|'radio'} [options.keyboard]
 * @param {HTMLElement} [options.keyTarget] Delegated keyboard target, if any.
 * @param {Function} [options.readValue] Current controlled value for delegation.
 * @param {Function} [options.listen] Feature-owned event registration.
 * @returns {{ update: Function, destroy: Function }}
 */
export function createSegmentedControl({
  buttons,
  valueOf,
  onChange,
  keyboard = 'none',
  keyTarget,
  readValue,
  listen,
}) {
  const options = [...buttons].filter(Boolean);
  const removers = [];
  let destroyed = false;
  const bind = (target, type, handler) => {
    const owned = (event) => {
      if (!destroyed) handler(event);
    };
    if (listen) listen(target, type, owned);
    else {
      target.addEventListener(type, owned);
      removers.push(() => target.removeEventListener(type, owned));
    }
  };
  for (const button of options)
    bind(button, 'click', () => {
      if (!button.disabled) onChange(valueOf(button), button);
    });
  const navigate = (event, from) => {
    const enabled = options.filter((button) => !button.disabled);
    const values = enabled.map(valueOf);
    const next = nextSegmentValue(values, from, event.key, {
      homeEnd: keyboard === 'radio',
    });
    if (next === undefined) return;
    const button = enabled.find((option) => valueOf(option) === next);
    event.preventDefault();
    if (keyTarget) {
      button.click();
      button.focus();
    } else {
      button.focus();
      if (next !== from) button.click();
    }
  };
  if (keyboard !== 'none') {
    if (keyTarget)
      bind(keyTarget, 'keydown', (event) => navigate(event, readValue()));
    else
      for (const button of options)
        bind(button, 'keydown', (event) => navigate(event, valueOf(button)));
  }
  return {
    update(value, presentation) {
      if (!destroyed)
        syncSegmentedControl(options, value, { valueOf, ...presentation });
    },
    destroy() {
      destroyed = true;
      for (const remove of removers.splice(0)) remove();
    },
  };
}

import { createSlider } from './slider.js';
import { syncSegmentedControl } from './segmentedControl.js';

const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};
const attribute = (node, key, value) => {
  if (node.getAttribute(key) !== value) node.setAttribute(key, value);
};
// Custom properties need setProperty; test fixtures carry a plain style bag.
const styleVar = (node, name, value) => {
  if (typeof node.style?.setProperty === 'function') {
    if (value) node.style.setProperty(name, value);
    else node.style.removeProperty(name);
  } else if (node.style) node.style[name] = value || '';
};

/**
 * Reconcile a layer row's quantitative slider block in place (keyed by the
 * descriptor id), so a refresh triggered by the slider's own input never
 * replaces the node under the pointer. The caller owns dispatch: it listens
 * for `input` on the row container and reads `.data-toggle-slider-input`.
 *
 * Descriptor: `{ id, label, ariaLabel, valueText, min, max, step, value,
 * track, ticks: [{ at, label }] }` — `track` is a CSS background painting the
 * runnable track (a color ramp doubles as the legend), `at` is 0..1.
 * @param {HTMLElement} container The row's `.data-toggle-controls` node.
 * @param {?object} slider Descriptor, or null to remove the block.
 * @param {{before?: ?Node}} [options] Insertion anchor for a new block.
 * @returns {?HTMLElement} The block, when rendered.
 */
export function syncSliderBlock(container, slider, { before = null } = {}) {
  if (!container) return null;
  const document = container.ownerDocument ?? globalThis.document;
  const existing = [...container.children].find(
    (node) => node.dataset?.sliderId,
  );
  if (!slider) {
    existing?.remove();
    return null;
  }
  let block = existing;
  if (!block || block.dataset.sliderId !== slider.id) {
    existing?.remove();
    block = document.createElement('div');
    block.className = 'data-toggle-slider';
    block.dataset.sliderId = slider.id;
    const head = document.createElement('div');
    head.className = 'data-toggle-slider-head';
    const label = document.createElement('span');
    label.className = 'data-toggle-slider-label';
    const value = document.createElement('span');
    value.className = 'data-toggle-slider-value gev-slider-value';
    head.append(label, value);
    const input = createSlider({
      documentRef: document,
      className: 'data-toggle-slider-input',
      min: slider.min,
      max: slider.max,
      step: slider.step,
      value: slider.value,
    });
    input.dataset.sliderId = slider.id;
    const ticks = document.createElement('div');
    ticks.className = 'data-toggle-slider-ticks';
    block.append(head, input, ticks);
    block._parts = { label, value, input, ticks };
    container.insertBefore(block, before);
  }
  const { label, value, input, ticks } = block._parts;
  set(label, 'textContent', slider.label ?? '');
  set(value, 'textContent', slider.valueText ?? '');
  set(input, 'min', String(slider.min));
  set(input, 'max', String(slider.max));
  set(input, 'step', String(slider.step ?? 1));
  // Never move the thumb under an active drag: the layer's rounded value can
  // sit a hair off the pointer, and a refresh runs on every input tick.
  if (document.activeElement !== input)
    set(input, 'value', String(slider.value));
  if (slider.ariaLabel) attribute(input, 'aria-label', slider.ariaLabel);
  if (slider.valueText) attribute(input, 'aria-valuetext', slider.valueText);
  const track = slider.track || '';
  if ((block.dataset.track || '') !== track) {
    styleVar(input, '--slider-track', track);
    block.dataset.track = track;
  }
  const signature = JSON.stringify(slider.ticks || []);
  if (block.dataset.ticks !== signature) {
    for (const node of [...ticks.children]) node.remove();
    for (const tick of slider.ticks || []) {
      const node = document.createElement('span');
      node.className = 'data-toggle-slider-tick';
      styleVar(node, '--at', `${(tick.at * 100).toFixed(2)}%`);
      node.textContent = tick.label;
      ticks.appendChild(node);
    }
    block.dataset.ticks = signature;
  }
  return block;
}

/**
 * Reconcile a one-of-many switch (`.gev-segmented` radiogroup) in place.
 * Buttons carry `data-chip-id` like chips so the row's delegated click handler
 * can resolve them; the caller matches `.data-toggle-segment`.
 *
 * Descriptor: `{ id, label, ariaLabel, options: [{ id, label, title, active,
 * disabled, params }] }` — `label` is an optional visible caption above the
 * buttons (the group itself is a flex item, so the caption is a sibling).
 * @param {HTMLElement} container The row's `.data-toggle-controls` node.
 * @param {?object} segmented Descriptor, or null to remove the group.
 * @param {{before?: ?Node}} [options] Insertion anchor for a new group.
 * @returns {?HTMLElement} The group, when rendered.
 */
export function syncSegmentedGroup(
  container,
  segmented,
  { before = null } = {},
) {
  if (!container) return null;
  const document = container.ownerDocument ?? globalThis.document;
  const existing = [...container.children].find(
    (node) => node.dataset?.segmentedId,
  );
  const existingCaption = [...container.children].find(
    (node) => node.dataset?.segmentedCaptionFor,
  );
  if (!segmented) {
    existing?.remove();
    existingCaption?.remove();
    return null;
  }
  let group = existing;
  if (!group || group.dataset.segmentedId !== segmented.id) {
    existing?.remove();
    existingCaption?.remove();
    group = document.createElement('div');
    group.className = 'gev-segmented data-toggle-segmented';
    group.dataset.segmentedId = segmented.id;
    group.setAttribute('role', 'radiogroup');
    container.insertBefore(group, before);
  }
  let caption = [...container.children].find(
    (node) => node.dataset?.segmentedCaptionFor === segmented.id,
  );
  if (segmented.label) {
    if (!caption) {
      caption = document.createElement('span');
      caption.className = 'data-toggle-segmented-label';
      caption.dataset.segmentedCaptionFor = segmented.id;
      container.insertBefore(caption, group);
    }
    set(caption, 'textContent', segmented.label);
  } else {
    caption?.remove();
  }
  if (segmented.ariaLabel) attribute(group, 'aria-label', segmented.ariaLabel);
  const stale = new Map();
  for (const node of [...group.children])
    if (node.dataset?.chipId) stale.set(node.dataset.chipId, node);
  const ordered = [];
  for (const option of segmented.options || []) {
    let button = stale.get(option.id);
    stale.delete(option.id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gev-segment data-toggle-segment';
      button.dataset.chipId = option.id;
      button.setAttribute('role', 'radio');
    }
    set(button, 'textContent', option.label);
    set(button, 'title', option.title || '');
    set(button, 'disabled', Boolean(option.disabled));
    ordered.push(button);
  }
  for (const node of stale.values()) node.remove();
  ordered.forEach((node, index) => {
    if (group.children[index] !== node)
      group.insertBefore(node, group.children[index] || null);
  });
  const active = (segmented.options || []).find((option) => option.active);
  syncSegmentedControl(ordered, active?.id, {
    valueOf: (button) => button.dataset.chipId,
    activeClass: 'active',
    rovingFocus: true,
  });
  return group;
}

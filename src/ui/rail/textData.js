/**
 * `v-text-data="text"`: the element's text, written into its one text node.
 * A `{{ }}` that is an element's only child is written with `textContent`,
 * which replaces the text node on every change; a readout that changes many
 * times a second keeps its node and changes only the node's data.
 */
function write(el, { value }) {
  const text = value == null ? '' : String(value);
  const node = el.firstChild;
  // An empty readout has no text node, as `textContent = ''` leaves it.
  if (text && node && node.nodeType === 3 && !node.nextSibling) {
    if (node.data !== text) node.data = text;
  } else if (el.textContent !== text) el.textContent = text;
}

export const vTextData = { mounted: write, updated: write };

import { ref } from 'vue';

// Panels can slide over their rail to the screen edge, one setting per side:
// the left column moves onto the left rail, the right column onto the right
// rail. Each panel header has the switch (UiPanelEdge); the choice is kept
// for the next visit and shows as a body class the stylesheet reads.
const KEY = 'gev.panelEdge';
function read() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) || '{}');
    return { left: saved.left === true, right: saved.right === true };
  } catch {
    return { left: false, right: false };
  }
}

export const panelEdge = ref(read());

function apply() {
  const body = globalThis.document?.body;
  if (!body) return;
  body.classList.toggle('panels-edge-left', panelEdge.value.left);
  body.classList.toggle('panels-edge-right', panelEdge.value.right);
}
apply();

/** Which side a panel element sits on, from the column it is in. */
export function panelSide(element) {
  return element?.closest?.('#right-context-rail, #cockpit-utility-controls')
    ? 'right'
    : 'left';
}

export function togglePanelEdge(side) {
  panelEdge.value = { ...panelEdge.value, [side]: !panelEdge.value[side] };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(panelEdge.value));
  } catch {
    // Without storage the choice lasts for this visit.
  }
  apply();
}

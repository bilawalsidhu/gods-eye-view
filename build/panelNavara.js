// The panel host transports Cesium assets; Navara workers need a web page.
export function createNavaraScene() {
  throw new Error('Navara is unavailable in the panel');
}

export function navaraToolBackend() {
  throw new Error('Navara is unavailable in the panel');
}

export function createWindFlowMesh() {
  throw new Error('Navara is unavailable in the panel');
}

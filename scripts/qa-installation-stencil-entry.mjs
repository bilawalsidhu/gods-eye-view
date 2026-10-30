// QA uses the production factory without moving Three into initial chunks.
export function loadInstallationGeometry() {
  return import('../src/layers/installations/render/navaraGeometry.js');
}

// Keep the instrumented renderer behind the same lazy boundary as the app.
export function loadFirmsRenderer() {
  return import('../src/layers/firms/render/navara.js');
}

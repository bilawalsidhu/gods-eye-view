import { createApplicationControls } from '../app/controls.js';
import { getStandaloneCatalog } from './catalog.js';
import { ENGINE_STORAGE_KEY } from '../app/engineChoice.js';

export function createStandaloneControls(options) {
  const controls = createApplicationControls({
    catalog: options?.catalog ?? getStandaloneCatalog(),
    ...options,
  });
  const select = document.getElementById('globe-engine');
  const container = document.getElementById('globe-engine-control');
  if (select && container) {
    const current = options.scene.engine.kind;
    select.value = current;
    const switchEngine = () => {
      const next = select.value;
      if (next === current || !['cesium', 'navara'].includes(next)) return;
      controls.styleManager.shareLinkManager.flush();
      const url = new URL(window.location.href);
      // Keep Back meaningful even when this visit began without ?engine=.
      url.searchParams.set('engine', current);
      window.history.replaceState(window.history.state, '', url);
      url.searchParams.set('engine', next);
      try {
        window.localStorage.setItem(ENGINE_STORAGE_KEY, next);
      } catch {
        // The explicit URL also works when storage is blocked.
      }
      select.value = current;
      window.location.assign(url);
    };
    select.addEventListener('change', switchEngine);
    container.hidden = false;
    options.defer(() => {
      select.removeEventListener('change', switchEngine);
      container.hidden = true;
    });
  }
  return controls;
}

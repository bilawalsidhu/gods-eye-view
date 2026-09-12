const STORAGE_KEY = 'gev:interface:v1';

// An explicit URL wins, then the reader's saved layout. New visitors opening a
// share get the full controls; ordinary first visits get the simple explorer.
export function preferredInterface(location, storage) {
  const requested = new URLSearchParams(location.search).get('view');
  if (requested === 'simple' || requested === 'full') return requested;
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (saved === 'simple' || saved === 'full') return saved;
  } catch { /* Storage can be unavailable. */ }
  return location.hash ? 'full' : 'simple';
}

export function initSimpleView() {
  let storage;
  try { storage = window.localStorage; } catch { /* Private browsing. */ }
  document.body.dataset.interface = preferredInterface(window.location, storage);
  const toggle = document.getElementById('interface-toggle');
  const layers = document.getElementById('data-toggles');
  const anchor = document.createComment('Full interface layer position');
  layers.before(anchor);

  function apply(mode) {
    document.body.dataset.interface = mode;
    const simple = mode === 'simple';
    if (simple) document.getElementById('simple-layer-host').append(layers);
    else anchor.after(layers);
    toggle.textContent = simple ? 'Full interface' : 'Simple view';
    toggle.setAttribute('aria-label', `Switch to ${simple ? 'full interface' : 'simple view'}`);
    window.dispatchEvent(new Event('resize'));
  }

  return function connect() {
    apply(document.body.dataset.interface);
    toggle.disabled = false;
    toggle.addEventListener('click', () => {
      const mode = document.body.dataset.interface === 'simple' ? 'full' : 'simple';
      // Clear a query override so reloading honors this explicit choice.
      const url = new URL(window.location.href);
      url.searchParams.delete('view');
      window.history.replaceState(window.history.state, '', url);
      try { storage?.setItem(STORAGE_KEY, mode); } catch { /* Session still works. */ }
      apply(mode);
      document.getElementById('first-run-launcher')?.setAttribute('hidden', '');
    });

    const city = document.getElementById('simple-city');
    const pills = [...document.querySelectorAll('#location-pills .location-pill')];
    for (const pill of pills) city.add(new Option(pill.textContent, pill.dataset.locationId));
    city.disabled = false;
    city.addEventListener('change', () => {
      const pill = pills.find(pill => pill.dataset.locationId === city.value);
      const firstLandmark = document.querySelector('#poi-row.expanded .poi-pill');
      if (pill?.classList.contains('active') && firstLandmark) firstLandmark.click();
      else pill?.click();
      // Treat this as a destination picker, so picking the same city later works.
      city.value = '';
    });

    for (const [id, target] of [
      ['simple-reset', 'reset-globe-view'],
      ['simple-share', 'share-btn'],
      ['simple-clear', 'clear-selected-layers'],
    ]) {
      const button = document.getElementById(id);
      button.disabled = false;
      button.addEventListener('click', () => document.getElementById(target).click());
    }
    // Cockpit controls must remain reachable if a tracked marker opens that view.
    window.addEventListener('gev:cockpit-mode-changed', (event) => {
      if (event.detail?.active) apply('full');
    });
  };
}

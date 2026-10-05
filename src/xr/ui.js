import { LAYERS, feedLabel } from './data.js';
import { REGIONS } from './geo.js';
import { viewUrl } from './routes.js';

export const spatialBrand = {
  name: "GOD'S EYE VIEW",
  colors: {
    background: '#09151f',
    surface: '#172c37',
    text: '#ecf8f5',
    muted: '#a7c1c8',
    accent: '#6ee7cd',
    accentText: '#071f1b',
    border: '#44707a',
  },
  fonts: { body: { family: 'Arial' }, display: { family: 'Arial' } },
};

export function mountSpatialUI({ onAction }) {
  const root = document.createElement('main');
  root.id = 'spatial-app';
  root.innerHTML = `
    <canvas id="spatial-canvas" aria-label="Interactive spatial Earth globe" tabindex="0"></canvas>
    <header class="spatial-header"><a class="spatial-wordmark" href="/" aria-label="God's Eye View home"><img src="/logo.svg" alt=""/><span>GOD’S EYE VIEW<small>SPATIAL INTELLIGENCE</small></span></a><div class="spatial-header-right"><span class="spatial-session"><i></i><span id="spatial-session-label">Desktop preview</span></span><a id="console-link" class="spatial-console-link">Open map console ↗</a></div></header>
    <section class="spatial-intro"><span class="spatial-eyebrow">A NEW PERSPECTIVE</span><h1>The world.<br/>Within reach.</h1><p>Explore Earth as a spatial intelligence globe. Bring aircraft, vessels, seismic events and orbital stations into view.</p><div class="spatial-entry"><button id="enter-xr" class="spatial-primary" disabled>Checking headset…</button><select id="xr-mode" aria-label="Headset mode"><option value="auto">Auto · MR preferred</option><option value="immersive-ar">Mixed reality</option><option value="immersive-vr">Virtual reality</option></select></div><p id="xr-support" class="spatial-support">Desktop interaction is ready.</p></section>
    <section class="spatial-layer-panel" aria-label="Intelligence layers"><div class="spatial-section-heading"><h2>Intelligence layers</h2><span>01 — 04</span></div><div id="spatial-layers"></div><div class="spatial-layer-note">Provider snapshots · no simulated contacts</div></section>
    <aside class="spatial-inspector" aria-label="Contact inspector"><span class="spatial-eyebrow">INSPECT / EXPLORE</span><h2 id="contact-name">A planet of signals.</h2><p id="contact-detail">Enable a layer, then select a colored contact on the globe to inspect its source and location.</p><p id="contact-location" class="spatial-coordinate">20° N &nbsp; 85° W · AMERICAS</p><div class="spatial-divider"></div><label for="region-select" class="spatial-label">Focus region</label><select id="region-select">${REGIONS.map((r, i) => `<option value="${i}">${r.name}</option>`).join('')}</select><div class="spatial-button-pair"><button data-action="rotate-left" aria-label="Rotate globe left">↶ Rotate</button><button data-action="rotate-right" aria-label="Rotate globe right">Rotate ↷</button></div><div class="spatial-button-pair"><button data-action="smaller">− Smaller</button><button data-action="larger">+ Larger</button></div><button class="spatial-reset" data-action="recenter">Recenter workspace</button><button class="spatial-reset" data-action="refresh">Refresh enabled feeds</button><details class="spatial-help"><summary>Controls & headset tools</summary><p>Drag to rotate · scroll to scale · click a contact. Arrow keys rotate, +/− scales, R recenters.</p><p>In XR, use the Spatial controls panel. Trigger or pinch selects; drag a panel’s white bar to place it. VR: stick forward aims teleport, release moves; sideways snap turns. MR: look at a surface and select empty space to place the globe.</p></details></aside>
    <footer class="spatial-footer"><span><i></i> EARTH / SPATIAL OBSERVATORY</span><span>Natural Earth · USGS · OpenSky · AISStream · CelesTrak</span><span id="spatial-clock"></span></footer>
    <div id="spatial-status" role="status" aria-live="polite"></div>
    <div class="spatial-context-error" id="spatial-error" hidden><h2>Spatial rendering unavailable</h2><p id="spatial-error-message"></p><a id="spatial-error-console">Open map console</a></div>`;
  document.body.replaceChildren(root);
  document.title = "God's Eye View / Spatial";
  root.querySelector('#console-link').href = viewUrl(location.href, 'console');
  root.querySelector('#spatial-error-console').href = viewUrl(
    location.href,
    'console',
  );
  for (const layer of LAYERS) {
    const button = document.createElement('button');
    button.className = 'spatial-layer';
    button.dataset.layer = layer.id;
    button.setAttribute('aria-pressed', 'false');
    const dot = document.createElement('i');
    dot.style.background = layer.color;
    const text = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = layer.name;
    const caption = document.createElement('small');
    caption.textContent = layer.label;
    const status = document.createElement('small');
    status.className = 'spatial-feed-status';
    status.textContent = 'Off';
    text.append(name, caption, status);
    const toggle = document.createElement('span');
    toggle.className = 'spatial-toggle';
    button.append(dot, text, toggle);
    root.querySelector('#spatial-layers').append(button);
    button.onclick = () => onAction('layer:' + layer.id);
  }
  root.querySelectorAll('[data-action]').forEach((button) => {
    button.onclick = () => onAction(button.dataset.action);
  });
  root.querySelector('#region-select').onchange = (event) =>
    onAction('region:' + event.target.value);
  let timer;
  return {
    root,
    canvas: root.querySelector('canvas'),
    enterButton: root.querySelector('#enter-xr'),
    modeSelect: root.querySelector('#xr-mode'),
    status(message) {
      const toast = root.querySelector('#spatial-status');
      toast.textContent = message;
      toast.classList.add('visible');
      clearTimeout(timer);
      timer = setTimeout(() => toast.classList.remove('visible'), 6000);
    },
    feeds(states) {
      for (const state of Object.values(states)) {
        const button = root.querySelector(`[data-layer="${state.id}"]`);
        button.setAttribute('aria-pressed', String(state.enabled));
        button.querySelector('.spatial-feed-status').textContent =
          feedLabel(state);
      }
    },
    session(state) {
      const { selected, capabilities, active, pending, secure } = state;
      const available =
        selected === 'immersive-ar'
          ? capabilities.ar
          : selected === 'immersive-vr' && capabilities.vr;
      const button = root.querySelector('#enter-xr');
      button.disabled = pending || (!active && !available);
      button.textContent = pending
        ? 'Connecting…'
        : active
          ? 'Exit headset'
          : available
            ? selected === 'immersive-ar'
              ? 'Enter mixed reality ↗'
              : 'Enter VR ↗'
            : 'Desktop preview';
      root.querySelector('#xr-mode').disabled = active || pending;
      root.querySelector('#xr-mode').value = state.mode;
      root.querySelector('#xr-support').textContent = !secure
        ? 'Open over HTTPS or localhost for headset access.'
        : available
          ? 'Controllers, hands & spatial pointers supported.'
          : 'No immersive headset detected. Explore with mouse, touch or keyboard.';
      root.querySelector('#spatial-session-label').textContent = active
        ? selected === 'immersive-ar'
          ? 'Mixed reality'
          : 'Virtual reality'
        : 'Desktop preview';
      root.classList.toggle('xr-active', active);
    },
    contact(record, state) {
      root.querySelector('#contact-name').textContent = record.name;
      root.querySelector('#contact-detail').textContent =
        `${record.detail}. ${state?.source || record.layer}${record.observedAtMs ? ' · ' + new Date(record.observedAtMs).toLocaleString() : ' · time unknown'}`;
      root.querySelector('#contact-location').textContent =
        `${record.lat.toFixed(3)}°, ${record.lon.toFixed(3)}° · ${state?.status === 'stale' ? 'STALE SNAPSHOT' : 'SNAPSHOT'}`;
    },
    clearContact() {
      root.querySelector('#contact-name').textContent = 'A planet of signals.';
      root.querySelector('#contact-detail').textContent =
        'Enable a layer, then select a colored contact on the globe to inspect its source and location.';
      root.querySelector('#contact-location').textContent =
        'EARTH · SPATIAL OBSERVATORY';
    },
    error(message) {
      root.querySelector('#spatial-error').hidden = false;
      root.querySelector('#spatial-error-message').textContent = message;
    },
    destroy() {
      clearTimeout(timer);
    },
  };
}

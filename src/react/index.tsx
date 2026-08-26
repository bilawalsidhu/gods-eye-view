/**
 * React entry point for God's Eye View.
 * Mounts the React app into #react-root overlaid on the Cesium globe.
 * Waits for window.__godsEyeView to be ready before mounting.
 */
import { createRoot } from 'react-dom/client';
import { App } from './App';

let mounted = false;
function mount() {
  if (mounted) return;
  mounted = true;
  let rootEl = document.getElementById('react-root');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'react-root';
    rootEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10';
    document.body.appendChild(rootEl);
  }
  const root = createRoot(rootEl);
  root.render(<App />);
}

if (window.__godsEyeView?.viewer) {
  mount();
} else {
  window.addEventListener('__gev_viewer_ready', () => mount(), { once: true });
  setTimeout(mount, 10_000); // safety fallback
}

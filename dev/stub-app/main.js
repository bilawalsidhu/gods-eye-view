/**
 * The whole application on the stub renderer (`src/render/stub`), with only
 * the contract's required members: the proof that the application runs on
 * those members alone, and needs no code that knows which renderer it is.
 * `scripts/qa-stub-boot.mjs` serves the application's page with this entry
 * in place of `src/main.js`, boots it headless, runs its data layers and
 * checks that no Cesium module loads.
 *
 * The stub runs nothing on its own: each animation frame here ticks it once.
 * `window.__stubBoot` exposes the application (a promise of it: the page's
 * language loads first) and the renderer it made.
 */
import { createStandaloneApplication } from '../../src/standalone/application.js';
import { createStubRendererPlugin } from '../../src/render/stub/index.js';
import { startPageLocale } from '../../src/i18n/page.js';

const renderers = [];

/** Tick a renderer once per animation frame until it is destroyed. */
function drive(renderer) {
  const step = () => {
    if (!renderers.includes(renderer)) return;
    renderer.testing.tick();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The required tier, no capability at all; `?capabilities=all` gives the
// stub every capability, to see what the layers draw with them.
const allCapabilities =
  new URLSearchParams(location.search).get('capabilities') === 'all';

const plugin = createStubRendererPlugin(
  allCapabilities ? {} : { capabilities: [] },
  (renderer) => {
    renderers.push(renderer);
    const destroy = renderer.destroy.bind(renderer);
    renderer.destroy = () => {
      renderers.splice(renderers.indexOf(renderer), 1);
      destroy();
    };
    drive(renderer);
  },
);

// The page's language loads before any view renders.
const application = startPageLocale(document).then(() =>
  createStandaloneApplication({
    renderer: plugin,
    allowQaRegistration: true,
  }),
);

window.__stubBoot = {
  application,
  renderers,
  started: application
    .then((app) => app.start())
    .then(
      () => ({ ok: true }),
      (error) => {
        console.error('Stub application failed to start:', error);
        return { ok: false, error: String(error?.stack || error) };
      },
    ),
};

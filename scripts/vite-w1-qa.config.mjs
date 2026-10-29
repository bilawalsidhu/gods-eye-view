// Local, instrumented preview only. The regular production build still
// excludes fixtures and the probe. Never publish this output directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import standalone from '../server/standalone/vite.config.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = [
  'src/geo/index.js',
  'src/time/clock.js',
  'src/renderGovernor.js',
  'src/bench/w1Feeds.js',
  'src/bench/syntheticFlights.js',
  'src/data/contextStore.js',
  'src/data/focusDeemphasis.js',
  'src/data/pickRegistry.js',
  'src/overlays/worldOverlay.js',
  'src/overlays/worldOverlayDraw.js',
  'src/data/radio.js',
  'src/voice/gevActions.js',
  'src/data/detection.js',
  'src/data/contactPlayback.js',
  'src/data/transitFeeds.js',
  'src/layers/transit/movement.js',
  'src/scopeMask.js',
  'src/bench/w2GroundProbe.js',
  'src/layers/firms/index.js',
  'scripts/qa-w2-firms-renderer-entry.mjs',
];
export default async (env) => {
  const config = await standalone(env);
  config.define['import.meta.env.DEV'] = 'true';
  config.build.outDir = process.env.GEV_QA_OUTDIR ?? 'qa-artifacts/w1-preview';
  config.build.manifest = true;
  config.build.rollupOptions.input = [
    path.join(root, 'index.html'),
    ...modules.map((module) => path.join(root, module)),
  ];
  config.build.rollupOptions.preserveEntrySignatures = 'strict';
  config.plugins.push({
    name: 'w1-qa-module-urls',
    // QA-only public native capability capture; normal production has none.
    transform(code, id) {
      const source = id.split('?')[0];
      if (source === path.join(root, 'src/globe/navara/movers/index.js')) {
        const marker = 'const mover = createMoverMesh(options, store, {';
        if (code.split(marker).length !== 2)
          throw new Error('W2 mover overlay probe lost its factory anchor');
        return code.replace(
          marker,
          'globalThis.__gevW2MoverOverlayProbe?.(targetOverlay);\n' + marker,
        );
      }
      if (source === path.join(root, 'src/globe/navara/overlayPass.js')) {
        const marker =
          'const reuseGlyphs = signatureMatches(signature, display.signature);';
        if (code.split(marker).length !== 2)
          throw new Error('W2 overlay cache probe lost its signature anchor');
        return code.replace(
          marker,
          marker +
            '\n globalThis.__gevW2OverlayCacheProbe?.(reuseGlyphs, signature !== null);',
        );
      }
      if (source !== path.join(root, 'src/globe/navara/index.js')) return null;
      const marker = 'await view.init();';
      if (code.split(marker).length !== 2)
        throw new Error('W2 native probe lost its initialised-view anchor');
      return code.replace(
        marker,
        marker +
          '\n globalThis.__gevW2NativeProbe?.({ view, EffectDesc, NavaraEffect });',
      );
    },
    configurePreviewServer(server) {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.resolve(root, config.build.outDir, '.vite/manifest.json'),
          'utf8',
        ),
      );
      server.middlewares.use((req, res, next) => {
        const module = req.url?.split('?')[0].slice(1);
        if (modules.includes(module)) {
          // Redirected module URLs can instantiate state twice. Re-export
          // the canonical asset so QA and the app share clocks/registries.
          res.writeHead(200, { 'Content-Type': 'text/javascript' });
          res.end(
            `export * from ${JSON.stringify('/' + manifest[module].file)};\n`,
          );
          return;
        }
        next();
      });
    },
  });
  return config;
};

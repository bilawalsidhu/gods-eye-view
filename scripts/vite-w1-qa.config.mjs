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
  'src/voice/gevActions.js',
  'src/data/detection.js',
  'src/scopeMask.js',
];
export default async (env) => {
  const config = await standalone(env);
  config.define['import.meta.env.DEV'] = 'true';
  config.build.outDir = 'qa-artifacts/w1-preview';
  config.build.manifest = true;
  config.build.rollupOptions.input = [
    path.join(root, 'index.html'),
    ...modules.map((module) => path.join(root, module)),
  ];
  config.build.rollupOptions.preserveEntrySignatures = 'strict';
  config.plugins.push({
    name: 'w1-qa-module-urls',
    configurePreviewServer(server) {
      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(root, config.build.outDir, '.vite/manifest.json'),
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where @navaramap/three keeps its prebuilt worker assets, or null. */
function defaultAssetsDir() {
  try {
    const entry = fileURLToPath(import.meta.resolve('@navaramap/three'));
    return path.join(path.dirname(entry), 'assets');
  } catch {
    return null;
  }
}

/**
 * Navara's prebuilt workers (@navaramap/three/dist/assets) load their wasm by
 * file name next to themselves (`new URL('x-hash.wasm', self.location)`), a
 * reference the bundler cannot see. When a build includes Navara (the
 * ?engine=navara chunk), copy every such wasm the bundle lacks into
 * `assets/` under its own name. A build without Navara gets none.
 * @param {{ assetsDir?: string | null }} [options]
 */
export function navaraWorkerAssets({ assetsDir } = {}) {
  return {
    name: 'navara-worker-assets',
    generateBundle(_options, bundle) {
      const usesNavara = Object.values(bundle).some(
        (file) => file.type === 'chunk' && file.code.includes('navara_wasm'),
      );
      if (!usesNavara) return;
      const dir = assetsDir === undefined ? defaultAssetsDir() : assetsDir;
      if (!dir || !existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith('.wasm')) continue;
        const fileName = `assets/${name}`;
        if (bundle[fileName]) continue;
        this.emitFile({
          type: 'asset',
          fileName,
          source: readFileSync(path.join(dir, name)),
        });
      }
    },
  };
}

const NAVARA_MODULE = /\/src\/globe\/navara\//;

/**
 * Rollup chunkFileNames: the lazy chunk holding the Navara engine
 * (src/globe/navara, with the Navara packages it pulls in) is named
 * `navara-engine-[hash].js`; every other chunk keeps Vite's default name.
 * Naming only (not manualChunks, which would pull modules shared with the
 * Cesium entry into the Navara chunk), so the chunking is unchanged.
 * @param {{ isEntry?: boolean, moduleIds?: string[] }} chunk
 * @returns {string}
 */
export function navaraChunkFileNames(chunk) {
  const navara =
    !chunk.isEntry &&
    (chunk.moduleIds ?? []).some((id) =>
      NAVARA_MODULE.test(id.replaceAll('\\', '/')),
    );
  return navara ? 'assets/navara-engine-[hash].js' : 'assets/[name]-[hash].js';
}

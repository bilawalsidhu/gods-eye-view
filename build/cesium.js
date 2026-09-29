import { createReadStream } from 'node:fs';
import { cp, stat } from 'node:fs/promises';
import path from 'node:path';
import externalGlobals from 'rollup-plugin-external-globals';

const CESIUM_SOURCE = 'node_modules/cesium/Build';
/** Runtime directories Cesium fetches by URL rather than through the bundler. */
const RUNTIME_DIRECTORIES = ['Assets', 'ThirdParty', 'Workers', 'Widgets'];

/** Cesium ships only these types; anything else is served as an opaque download. */
const CONTENT_TYPES = new Map(
  Object.entries({
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ktx2': 'image/ktx2',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }),
);

/**
 * Resolve a request path against a directory without escaping it.
 *
 * Returns null for traversal, absolute-drive and encoded-separator attempts so
 * the dev middleware can never read outside the Cesium build directory.
 */
export function resolveAssetPath(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const resolved = path.resolve(root, '.' + path.posix.resolve('/', decoded));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(prefix) ? resolved : null;
}

/** Serve one Cesium build directory read-only; never write, list or traverse. */
function staticAssets(root) {
  return async (request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    const file = resolveAssetPath(root, request.url || '/');
    if (!file) return next();
    let stats;
    try {
      stats = await stat(file);
    } catch {
      return next();
    }
    if (!stats.isFile()) return next();
    response.setHeader(
      'Content-Type',
      CONTENT_TYPES.get(path.extname(file).toLowerCase()) ||
        'application/octet-stream',
    );
    response.setHeader('Content-Length', stats.size);
    // Cesium loads workers and WebAssembly through URLs the page did not author.
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.method === 'HEAD') return response.end();
    createReadStream(file).on('error', next).pipe(response);
  };
}

/**
 * Publish Cesium's prebuilt library and runtime assets to Vite.
 *
 * Development serves the unminified build straight from `node_modules`; builds
 * keep `cesium` out of the bundle and load the prebuilt global instead, so the
 * application chunk stays free of the whole engine.
 */
export function cesiumPlugin({ base = 'cesium/' } = {}) {
  let baseUrl = base.endsWith('/') ? base : base + '/';
  let outDir = 'dist';
  let isBuild = false;

  return {
    name: 'gev-cesium',
    config(config, { command }) {
      isBuild = command === 'build';
      const root = config.base === '' ? './' : (config.base ?? '/');
      baseUrl = path.posix.join(root, baseUrl);
      if (!isBuild)
        return { define: { CESIUM_BASE_URL: JSON.stringify(baseUrl) } };
      return {
        build: {
          rollupOptions: {
            external: ['cesium'],
            plugins: [externalGlobals({ cesium: 'Cesium' })],
          },
        },
      };
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer({ middlewares }) {
      middlewares.use(
        path.posix.join('/', baseUrl),
        staticAssets(path.resolve(CESIUM_SOURCE, 'CesiumUnminified')),
      );
    },
    transformIndexHtml() {
      const tags = [
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: path.posix.join(baseUrl, 'Widgets/widgets.css'),
          },
        },
      ];
      if (isBuild)
        tags.push({
          tag: 'script',
          attrs: { src: path.posix.join(baseUrl, 'Cesium.js') },
        });
      return tags;
    },
    async closeBundle() {
      if (!isBuild) return;
      const from = path.resolve(CESIUM_SOURCE, 'Cesium');
      const to = path.join(outDir, baseUrl);
      for (const directory of RUNTIME_DIRECTORIES)
        await cp(path.join(from, directory), path.join(to, directory), {
          recursive: true,
        });
      await cp(path.join(from, 'Cesium.js'), path.join(to, 'Cesium.js'));
    },
  };
}

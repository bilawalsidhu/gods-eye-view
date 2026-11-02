/**
 * The MCP Apps panel build. A panel loads the app through its MCP server,
 * one tool call per file (see src/tools/globePanel.js), so the app must be
 * few files: one app script, one stylesheet, and Cesium's own script, which
 * carries its workers and starts them from memory. The build is served at
 * PANEL_BASE next to the app.
 */

// The panel loads these paths (src/tools/globePanel.js); a test keeps the
// two in step.
export const PANEL_BASE = '/panel/';
/** The script the panel runs ahead of Cesium's workers (workerFilesPrelude). */
export const PANEL_WORKER_PRELUDE_PATH = 'cesium/worker-prelude.js';
export const PANEL_OUT_DIR = 'dist/panel';

/** A browser Vite config changed to produce the panel build. */
export function panelBuildConfig(config) {
  return {
    ...config,
    base: PANEL_BASE,
    build: {
      ...config.build,
      outDir: PANEL_OUT_DIR,
      emptyOutDir: true,
      modulePreload: false,
      cssCodeSplit: false,
      rollupOptions: {
        ...config.build?.rollupOptions,
        output: { inlineDynamicImports: true },
      },
    },
  };
}

const CONTENT_TYPES = {
  '.css': 'text/css',
  '.geojsonl': 'application/geo+json-seq',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

/**
 * Vite plugin serving the panel build at PANEL_BASE on the dev server, as
 * the preview server and production builds serve it from the build output.
 */
export function panelBuildPlugin({ outDir = PANEL_OUT_DIR } = {}) {
  return {
    name: 'panel-build',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const { pathname } = new URL(req.url || '/', 'http://localhost');
        if (!pathname.startsWith(PANEL_BASE)) return next();
        const { readFile } = await import('node:fs/promises');
        const { extname, resolve, sep } = await import('node:path');
        const root = resolve(server.config.root, outDir);
        let relative;
        try {
          relative = decodeURIComponent(pathname.slice(PANEL_BASE.length));
        } catch {
          res.statusCode = 400;
          res.end('Bad path');
          return;
        }
        const file = resolve(root, relative || 'index.html');
        if (file !== root && !file.startsWith(root + sep)) return next();
        try {
          const body = await readFile(file);
          res.setHeader(
            'Content-Type',
            CONTENT_TYPES[extname(file)] || 'application/octet-stream',
          );
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end(
            relative ? 'Not found' : 'No panel build; run npm run build:panel',
          );
        }
      });
    },
  };
}

/**
 * Cesium files its workers load themselves, as paths under Cesium's base.
 * Workers request them from the panel page's own site, which has none of
 * the app's files, so the panel build embeds them in the workers script.
 */
export const PANEL_WORKER_FILES = Object.freeze([
  'Assets/approximateTerrainHeights.json',
]);

/**
 * A script, run in each worker before Cesium's, that answers the worker's
 * requests for `files` (Cesium-relative path → text) from memory and lets
 * every other request through.
 */
export function workerFilesPrelude(files) {
  const answer = (FILES) => {
    const find = (url) => {
      const path = String(url).split(/[?#]/)[0];
      for (const name of Object.keys(FILES))
        if (path.endsWith(`/${name}`)) return FILES[name];
      return null;
    };
    const xhr = XMLHttpRequest.prototype;
    const { open, send, setRequestHeader } = xhr;
    xhr.open = function (method, url, ...rest) {
      this.__gevFile = find(url);
      if (this.__gevFile === null) return open.call(this, method, url, ...rest);
    };
    xhr.setRequestHeader = function (...args) {
      if (this.__gevFile === null) return setRequestHeader.apply(this, args);
    };
    xhr.send = function (body) {
      const text = this.__gevFile;
      if (text === null || text === undefined) return send.call(this, body);
      const type = this.responseType;
      const response =
        type === 'json'
          ? JSON.parse(text)
          : type === 'arraybuffer'
            ? new TextEncoder().encode(text).buffer
            : text;
      const state = {
        readyState: 4,
        status: 200,
        statusText: 'OK',
        response,
        responseText: typeof response === 'string' ? response : '',
        getAllResponseHeaders: () => 'content-type: application/json\r\n',
        getResponseHeader: (name) =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      };
      for (const [name, value] of Object.entries(state))
        Object.defineProperty(this, name, { configurable: true, value });
      setTimeout(() => {
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new ProgressEvent('load'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      });
    };
  };
  return `(${answer})(${JSON.stringify(files)});\n`;
}

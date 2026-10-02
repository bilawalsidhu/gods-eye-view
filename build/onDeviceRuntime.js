import { createRequire } from 'node:module';
import path from 'node:path';

// Two of the LiteRT-LM package's four builds: relaxed SIMD with JavaScript
// promise integration (current Chrome and Edge) and the most compatible one.
const LITERT_VARIANTS = {
  internal: 'litertlm_wasm_internal',
  compatAsyncify: 'litertlm_wasm_compat_asyncify_internal',
};
const ASSETS_MODULE = path.join(
  'src',
  'voice',
  'local',
  'workers',
  'runtimeAssets.js',
);
// kokoro-js imports `phonemizer`, which embeds eSpeak NG. The build never
// includes it: the import resolves to this loader, which downloads the pinned
// file from the public npm CDN at runtime and checks its SHA-256.
const PHONEMIZER_MODULE = path.join(
  'src',
  'voice',
  'local',
  'workers',
  'phonemizerRuntime.js',
);

/** Strings that only appear in the eSpeak NG phonemizer build. */
export const ESPEAK_MARKERS = Object.freeze([
  'eSpeakNGWorker',
  'espeak-ng-data',
  'espeakEVENT',
]);

/** Absolute path of the runtime phonemizer loader for a checkout. */
export function phonemizerLoaderPath(root = process.cwd()) {
  return path.join(root, PHONEMIZER_MODULE);
}

/** Names of emitted chunks or assets that contain eSpeak NG code. */
export function findEspeakChunks(bundle) {
  const found = [];
  for (const [name, output] of Object.entries(bundle || {})) {
    const text =
      typeof output.code === 'string'
        ? output.code
        : typeof output.source === 'string'
          ? output.source
          : output.source instanceof Uint8Array
            ? Buffer.from(output.source).toString('latin1')
            : '';
    if (ESPEAK_MARKERS.some((marker) => text.includes(marker)))
      found.push(name);
  }
  return found;
}

const posix = (file) => file.split(path.sep).join('/');

/** Directory of the installed package that `from` resolves `name` to. */
function packageDir(from, name) {
  const entry = createRequire(from).resolve(name);
  const marker = `${path.sep}node_modules${path.sep}${name.split('/').join(path.sep)}${path.sep}`;
  const at = entry.lastIndexOf(marker);
  if (at < 0) throw new Error(`Cannot locate ${name} from ${from}`);
  return entry.slice(0, at + marker.length - 1);
}

/**
 * Serves the on-device voice runtimes from the application build instead of
 * a CDN. It replaces src/voice/local/workers/runtimeAssets.js with imports
 * of the installed LiteRT-LM Emscripten loaders (classic scripts, exported
 * here as modules) and wasm files, and the ONNX Runtime Web files that the
 * two transformers.js copies (speech recognition, Kokoro) use.
 */
export function onDeviceRuntimePlugin({ root = process.cwd() } = {}) {
  let paths = null;
  const resolvePaths = () => {
    if (paths) return paths;
    const rootFile = path.join(root, 'package.json');
    const require = createRequire(rootFile);
    const litert = path.join(packageDir(rootFile, '@litert-lm/core'), 'wasm');
    const ort = path.join(
      packageDir(
        require.resolve('@huggingface/transformers'),
        'onnxruntime-web',
      ),
      'dist',
    );
    const kokoroTransformers = path.join(
      packageDir(require.resolve('kokoro-js'), '@huggingface/transformers'),
      'dist',
    );
    paths = {
      assets: path.join(root, ASSETS_MODULE),
      loaders: new Set(
        Object.values(LITERT_VARIANTS).map((name) =>
          path.join(litert, `${name}.js`),
        ),
      ),
      source() {
        const lines = [];
        const runtimes = [];
        for (const [key, name] of Object.entries(LITERT_VARIANTS)) {
          const file = posix(path.join(litert, name));
          lines.push(
            `import ${key}Factory from ${JSON.stringify(`${file}.js`)};`,
          );
          lines.push(
            `import ${key}Wasm from ${JSON.stringify(`${file}.wasm?url`)};`,
          );
          runtimes.push(
            `${key}: { ModuleFactory: ${key}Factory, wasmUrl: ${key}Wasm }`,
          );
        }
        const onnx = [];
        for (const [key, dir, name] of [
          ['transformers', ort, 'ort-wasm-simd-threaded.asyncify'],
          ['kokoro', kokoroTransformers, 'ort-wasm-simd-threaded.jsep'],
        ]) {
          const file = posix(path.join(dir, name));
          lines.push(
            `import ${key}Mjs from ${JSON.stringify(`${file}.mjs?url`)};`,
          );
          lines.push(
            `import ${key}OrtWasm from ${JSON.stringify(`${file}.wasm?url`)};`,
          );
          onnx.push(`${key}: { mjs: ${key}Mjs, wasm: ${key}OrtWasm }`);
        }
        lines.push(`export const litertRuntimes = { ${runtimes.join(', ')} };`);
        lines.push(`export const onnxWasmPaths = { ${onnx.join(', ')} };`);
        lines.push('export function requireRuntime(value) { return value; }');
        return lines.join('\n');
      },
    };
    return paths;
  };
  const phonemizer = phonemizerLoaderPath(root);
  return {
    name: 'gev-on-device-runtime',
    enforce: 'pre',
    resolveId(source) {
      return source === 'phonemizer' ? phonemizer : null;
    },
    generateBundle(_options, bundle) {
      const found = findEspeakChunks(bundle);
      if (found.length)
        this.error(
          `eSpeak NG phonemizer code must not be bundled (found in ${found.join(', ')})`,
        );
    },
    load(id) {
      const file = path.normalize(id.split('?')[0]);
      return file === resolvePaths().assets ? resolvePaths().source() : null;
    },
    transform(code, id) {
      const file = path.normalize(id.split('?')[0]);
      if (!file.endsWith('.js') || !resolvePaths().loaders.has(file))
        return null;
      // Modules are strict: the loaders' debug hook declares a function
      // inside a block, which only sloppy scripts hoist.
      const prelude =
        'var custom_dbg = function () { console.warn.apply(console, arguments); };\n';
      return {
        code: `${prelude}${code}\nexport default ModuleFactory;\n`,
        map: null,
      };
    },
  };
}

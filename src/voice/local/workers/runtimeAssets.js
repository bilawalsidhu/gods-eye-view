// The application build replaces this module (build/onDeviceRuntime.js)
// with the installed LiteRT-LM and ONNX Runtime Web loaders and wasm URLs,
// so on-device voice never fetches runtime code from a CDN. Builds without
// that plugin get these empty values and refuse to start.

/** LiteRT-LM builds: {internal, compatAsyncify} of {ModuleFactory, wasmUrl}. */
export const litertRuntimes = null;

/** ONNX Runtime Web {mjs, wasm} URLs for each transformers.js copy. */
export const onnxWasmPaths = { transformers: null, kokoro: null };

/** Throws when this build does not include the on-device runtimes. */
export function requireRuntime(value, name) {
  if (!value)
    throw new Error(`On-device voice runtime missing from this build: ${name}`);
  return value;
}

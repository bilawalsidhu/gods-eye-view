/**
 * Stands in for satellite.js's optional WASM propagator at build time.
 *
 * `satellite.js` 7.1.0 re-exports a WASM `BulkPropagator` from its package root, behind two
 * private subpath imports (`#wasm-single-thread`, `#wasm-multi-thread`) that resolve to
 * emscripten output. The multi-threaded one carries a top-level
 * `await import('node:worker_threads')` behind an `if (isNode)` guard, which a browser bundler
 * cannot resolve, so importing anything at all from `satellite.js` fails the build.
 *
 * Nothing in this project uses that propagator: the pure-JS `propagate` costs 3.5 ms for a
 * thousand satellites and 14 ms for ten thousand, in a worker, which is well inside a 60fps
 * frame. `vite.config.ts` aliases both subpaths here so 400 KB of emscripten output stays out
 * of the bundle along with the node import.
 *
 * It throws rather than returning something, because reaching it would mean code asked for the
 * WASM runtime and got a shim. If that day comes, drop the alias and take the emscripten
 * output, rather than making this pretend.
 */

export default function wasmPropagatorAbsent(): never {
  throw new Error(
    "satellite.js's WASM propagator is deliberately excluded from this bundle; see " +
      'src/globe/satellites/wasm-propagator-absent.ts',
  );
}

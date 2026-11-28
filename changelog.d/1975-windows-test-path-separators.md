- Normalize Windows path separators in test assertions. `src/queries/heights.test.mjs`,
  `src/data/inputOwnership.test.mjs`, `src/render/cesium/internals.test.mjs`, and
  `src/render/contract/contract.test.mjs` now pass on Windows instead of failing
  due to backslash vs forward slash path mismatches (djabhi31, #1975).

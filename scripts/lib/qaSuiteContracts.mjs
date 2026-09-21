/**
 * Per-suite invocation and timeout contracts shared by the QA orchestrator
 * (`scripts/qa-all.mjs`) and the quiet-window runner (`scripts/qa-when-quiet.mjs`).
 *
 * Keep these tables here and BOTH entrypoints importing them: two copies of
 * "how suite X wants to be invoked" is how the argv contract drifts.
 */

// Per-suite invocation overrides. Most suites take `[url, --url url]`;
// the map exists for the few that don't:
//  - qa-voice-wav reads argv[2] as the app URL and argv[3] as the WAV fixture
//    path, so a `--url` flag would be mistaken for a fixture path.
//  - qa-cockpit-plates asserts real-GPU plate rendering unless `--swiftshader`
//    is passed (its structural-plate mode). This NAS has no GPU, so the
//    default mode can never pass here; SwiftShader mode still exercises the
//    full plate pipeline.
export const SUITE_ARGV_OVERRIDES = {
  'qa-voice-wav.mjs': (baseUrl) => [baseUrl],
  'qa-cockpit-plates.mjs': (baseUrl) => [baseUrl, '--url', baseUrl, '--swiftshader'],
};

// Wall-clock ceiling per suite (ms). The default covers the ordinary
// harnesses; the two matrix/baseline suites embed long inner waits
// (qa-l9-matrix even runs `npm test` inside itself) and were measured to
// need more.
export const SUITE_TIMEOUT_OVERRIDES = {
  // Measured 2026-09-16 on the shared NAS box under software WebGL: 4500 s
  // still ended the run after D8 (≈82 min through D8 under the concurrent
  // dsc load bursts), while the morning run's D9-D12 tail took ≈4 min
  // (D8 log 12:49:36 → overlay-baseline json 12:52:41) — ≈86 min total.
  // 95 min keeps ≈9 min of headroom for load swings.
  'qa-l9-matrix.mjs': 5_700_000,
  'qa-overlay-baseline.mjs': 1_800_000,
};

/**
 * Resolve a suite's argv: its override if declared, otherwise the standard
 * `[baseUrl, --url baseUrl]` contract.
 *
 * @param {string} suiteFile e.g. `qa-radio.mjs`
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function suiteArgv(suiteFile, baseUrl) {
  const override = SUITE_ARGV_OVERRIDES[suiteFile];
  return override ? override(baseUrl) : [baseUrl, '--url', baseUrl];
}

/**
 * Resolve a suite's wall-clock ceiling in ms.
 *
 * @param {string} suiteFile e.g. `qa-radio.mjs`
 * @param {number} defaultMs
 * @returns {number}
 */
export function suiteTimeoutMs(suiteFile, defaultMs) {
  return SUITE_TIMEOUT_OVERRIDES[suiteFile] ?? defaultMs;
}

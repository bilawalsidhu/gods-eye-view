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
  // 75 min: 15 scenes × (boot + layer data + 10 s of sampled motion/rest)
  // measured 22 min quiet, but each scene's boot can take up to its 240 s
  // window under fleet load — 30 min cut run4b/run6c mid-scenes, and 45 min
  // cut run7 AND run8 (2026-09-24) with 10/13 scenes OK and 2-3 scenes to
  // go; 15 × 240 s of worst-case boot alone is 60 min.
  'qa-overlay-baseline.mjs': 4_500_000,
  // Heaviest suite on the box (52 checks: cockpit + tracking + CCTV +
  // overlays). Its armored probe survives a mid-run burst (renderer
  // unresponsive ~5 min, then recovery — RUN 3i), but the cumulative
  // degraded throughput needs more than the 15-min default ceiling.
  'qa-cockpit-utility.mjs': 1_500_000,
  // The dolly clamps its tick to 0.25 s of SIMULATION time per rendered
  // frame (advanceRouteFlight), so at software-GL cadence (~0.6-1 fps) the
  // 81 s evidence flight needs 5-9 WALL minutes — a wall-clock capture window
  // cannot cover it (run3l cut the flight at ~17%). The suite now exits on
  // the dolly's own completion signal; this ceiling just bounds the whole
  // run (boot + setup + flight + interrupt case + analysis).
  // 60 min: the run is TWO full flights (evidence capture with an internal
  // ~11 min budget each at software-GL, then the interrupt case) plus boot
  // and analysis. 25 min cut run5/run6c mid-analysis; 40 min cut run7
  // (2026-09-24) during the interrupt flight even from a load-35 start —
  // the two-flight shape simply exceeds 40 min on this box.
  'qa-flyroute-cinema.mjs': 3_600_000,
};

// Suites that exit nonzero with a self-declared key gate cannot run on this
// machine by design — we do not fabricate credentials. Both orchestrators
// recognize these markers in a failing suite's output and report it as
// ENV-GATED instead of FAIL.
export const ENV_GATE_MARKERS = [
  'run against the keyed dev server',
  'the A/B needs live flow',
  'the baseline needs live OSM',
  'live AIS needs a keyed server',
  'OPENAI_API_KEY is not set',
];

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

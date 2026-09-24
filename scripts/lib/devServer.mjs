// Shared dev-server reachability probe.
//
// Most Puppeteer suites start by fetching the app URL once and failing the
// run on any error. Under CI-fleet load that single fetch is not reliable:
// during the run4b sweep (2026-09-23) eight consecutive suites died in <0.1
// min with "fetch failed" while the server stayed up (it answered 200 again
// the moment the load peak passed) — one transient refusal counted as a
// suite failure. Bounded retries remove that false-fail class without
// masking a genuinely dead server: after the last attempt the caller still
// fails.
//
// `devServerReachable` returns a boolean and prints the diagnosis on final
// failure (for layers that degrade instead of exiting);
// `assertDevServerReachable` prints and exits 2 (the suites' preflight
// convention). Replaces the ~20 per-suite copies of the same fetch-once
// check.

export async function devServerReachable(appUrl, { attempts = 4, delayMs = 2500 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) return true;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  console.error(`\x1b[31mDev server not reachable at ${appUrl} (${lastError?.message ?? 'unknown error'}) after ${attempts} attempts.\x1b[0m`);
  console.error('Start it first:  npm run dev  (or ./scripts/dev-fresh.sh on macOS)');
  return false;
}

export async function assertDevServerReachable(appUrl, options = {}) {
  if (!(await devServerReachable(appUrl, options))) {
    process.exit(2);
  }
}

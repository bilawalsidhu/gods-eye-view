#!/usr/bin/env node
// Print the dev server's API health report as a table.
//
//   npm run health                      # against http://localhost:4173
//   GEV_URL=http://localhost:5173 npm run health
//   npm run health -- --fresh           # bypass the 60 s report cache
//   npm run health -- --json            # raw JSON
//
// Exit code is 1 when a required service is not live, 2 when the server is
// unreachable, so the macOS launcher and CI can gate on it.

const base = (process.env.GEV_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/$/, '');
const fresh = process.argv.includes('--fresh');
const json = process.argv.includes('--json');

let report;
try {
  const res = await fetch(`${base}/api/health?format=json${fresh ? '&fresh=1' : ''}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  report = await res.json();
} catch (error) {
  console.error(`api-health: cannot reach ${base}/api/health (${error?.message || error})`);
  process.exit(2);
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const width = Math.max(...report.services.map((s) => s.label.length));
  for (const s of report.services) {
    const state = s.state.toUpperCase().padEnd(12);
    console.log(`${s.label.padEnd(width)}  ${state} ${String(s.ms).padStart(5)} ms  ${s.detail}`);
  }
  const sum = report.summary;
  console.log(`\n${sum.live} live · ${sum.degraded} degraded · ${sum.unconfigured} no key · ${sum.failed} down${report.cached ? '  (cached)' : ''}`);
}
process.exit(report.summary?.requiredFailed ? 1 : 0);

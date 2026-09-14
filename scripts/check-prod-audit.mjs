#!/usr/bin/env node
/**
 * Production-dependency audit gate (`npm run check:audit`).
 *
 * Fails on HIGH/CRITICAL advisories in the RUNTIME dependency set
 * (`npm audit --omit=dev`). Dev-only advisories never fail this gate — but
 * they are not silently waived either: the plan (docs/PLAN.md Phase 6)
 * requires a rationale IN THIS FILE's waiver table before an advisory may be
 * skipped, and every waiver carries an expiry so stale justifications
 * resurface instead of rotting.
 *
 * A waiver is keyed by the advisory's module name and matches only the
 * severities listed. An expired waiver is treated as missing, so the finding
 * fails the gate again until someone re-justifies it.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Waivers for production advisories we have decided to ship anyway.
 * Empty today: `npm audit --omit=dev` is clean (2026-09-13). The table
 * exists so the FIRST high/critical runtime advisory arrives as a reviewed
 * decision, not a red CI or a silent pass.
 *
 * @type {Array<{module: string, severities: string[], rationale: string, expires: string}>}
 */
const WAIVERS = [
  // {
  //   module: 'example-pkg',
  //   severities: ['high'],
  //   rationale: 'No fixed version; the vulnerable code path (X) is unreachable '
  //     + 'because we never call Y (verified 2026-09-13, see docs/PLAN.md).',
  //   expires: '2026-12-31',
  // },
];

const FAIL_SEVERITIES = new Set(['high', 'critical']);

function loadWaivers() {
  const now = new Date().toISOString().slice(0, 10);
  return WAIVERS.map((w) => {
    if (!w.module || !Array.isArray(w.severities) || !w.severities.length) {
      throw new Error(`malformed waiver (needs module + severities): ${JSON.stringify(w)}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.expires || '')) {
      throw new Error(`waiver for ${w.module} needs an expires date (YYYY-MM-DD)`);
    }
    if (!w.rationale || w.rationale.length < 20) {
      throw new Error(`waiver for ${w.module} needs a real rationale`);
    }
    // Expired = missing: the finding resurfaces and must be re-justified.
    return w.expires >= now ? w : null;
  }).filter(Boolean);
}

function runAudit() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  // npm audit exits non-zero when it FINDS vulnerabilities — that is data,
  // not a spawn failure. Only a missing manifest or broken npm throws here.
  if (result.error || (result.status === null && !result.stdout)) {
    throw new Error(`npm audit failed to run: ${result.error?.message || 'no output'}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit produced unparseable output: ${String(result.stdout).slice(0, 400)}`);
  }
  return { report: parsed, exitCode: result.status ?? 0 };
}

function findingsForSeverity(report) {
  const findings = [];
  for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
    if (!FAIL_SEVERITIES.has(vuln.severity)) continue;
    const via = (vuln.via || [])
      .map((v) => (typeof v === 'string' ? v : `${v.title} (${v.url || 'no url'})`))
      .join('; ');
    findings.push({ name, severity: vuln.severity, range: vuln.range, via, fixAvailable: vuln.fixAvailable });
  }
  return findings;
}

export function evaluateAudit({ report, waivers = [] }) {
  const findings = findingsForSeverity(report);
  const waived = new Set(
    waivers.flatMap((w) => findings
      .filter((f) => f.name === w.module && w.severities.includes(f.severity))
      .map((f) => f.name)),
  );
  const violations = findings.filter((f) => !waived.has(f.name));
  return { findings, waived: [...waived], violations };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { report } = runAudit();
  const waivers = loadWaivers();
  const { findings, waived, violations } = evaluateAudit({ report, waivers });

  const prodDeps = Object.keys(report.metadata?.dependencies || {}).length;
  if (!findings.length) {
    console.log(`AUDIT-GATE PASS — ${prodDeps} runtime dependency rows scanned, no high/critical advisories`);
  } else {
    console.log(`AUDIT-GATE scanned ${prodDeps} runtime dependency rows: ${findings.length} high/critical finding(s)`);
    for (const f of findings) {
      const tag = waived.includes(f.name) ? 'WAIVED' : 'VIOLATION';
      console.log(`  [${tag}] ${f.name} (${f.severity}, range ${f.range}) — ${f.via}`);
      console.log(`           fixAvailable: ${f.fixAvailable ? JSON.stringify(f.fixAvailable) : 'none'}`);
      if (tag === 'WAIVED') {
        console.log(`           rationale: ${waivers.find((w) => w.module === f.name)?.rationale}`);
      }
    }
    if (violations.length) {
      console.error(
        `AUDIT-GATE FAIL — ${violations.length} unwaived high/critical runtime advisory(ies). `
        + 'Fix them, or add a reviewed, expiring waiver in scripts/check-prod-audit.mjs (WAIVERS) '
        + 'with a rationale — never silently.',
      );
      process.exit(1);
    }
    console.log('AUDIT-GATE PASS — all findings carry reviewed waivers');
  }
}

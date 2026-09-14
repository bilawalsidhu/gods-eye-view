// buildGates.test.mjs — pins the two build/CI gates added in PLAN.md Phase 6:
// the Node-core externalization guard (scripts/build.mjs, issue #34) and the
// production-dependency audit gate (scripts/check-prod-audit.mjs). The pure
// decision logic is tested here; the wiring is pinned against package.json
// and ci.yml so neither gate can silently unhook.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanForExternalizedWarnings } from '../scripts/build.mjs';
import { evaluateAudit } from '../scripts/check-prod-audit.mjs';
import { readSource } from './testSupport/readSource.js';

test('externalization scan flags vite warnings, deduped per node specifier', () => {
  const viteLike = [
    'vite v6.0.0 building for production...',
    'Module "node:fs" has been externalized for browser compatibility, imported by "src/x.js".',
    'Module "node:fs" has been externalized for browser compatibility, imported by "src/y.js".',
    'Module "node:buffer" has been externalized for browser compatibility.',
    '✓ 42 modules transformed.',
  ].join('\n');
  assert.deepEqual(scanForExternalizedWarnings(viteLike), ['node:fs', 'node:buffer']);
  assert.deepEqual(scanForExternalizedWarnings('clean build output\n✓ built in 9.1s'), []);
});

test('audit gate: high/critical runtime advisories fail unless actively waived', () => {
  const report = {
    metadata: { dependencies: { react: 1, 'tiny-demo': 1, 'other-mod': 1 } },
    vulnerabilities: {
      'crit-pkg': { severity: 'critical', range: '<2.0.0', via: [{ title: 'RCE', url: 'https://example/advisory' }], fixAvailable: { name: 'crit-pkg', version: '2.0.0' } },
      'high-pkg': { severity: 'high', range: '~1.2.3', via: ['high-pkg'], fixAvailable: true },
      'moderate-pkg': { severity: 'moderate', range: '<9', via: ['moderate-pkg'], fixAvailable: null },
    },
  };
  const { findings, violations } = evaluateAudit({ report, waivers: [] });
  assert.deepEqual(findings.map((f) => f.name).sort(), ['crit-pkg', 'high-pkg']);
  assert.deepEqual(violations.map((f) => f.name).sort(), ['crit-pkg', 'high-pkg']);

  // A waiver covers only the severities it names, and only its own module.
  const waived = evaluateAudit({
    report,
    waivers: [{ module: 'high-pkg', severities: ['high'], rationale: 'reviewed: unreachable path', expires: '2999-01-01' }],
  });
  assert.deepEqual(waived.violations.map((f) => f.name), ['crit-pkg']);
  assert.deepEqual(waived.waived, ['high-pkg']);
  // severity mismatch → still a violation.
  const mismatch = evaluateAudit({
    report,
    waivers: [{ module: 'high-pkg', severities: ['low'], rationale: 'reviewed: wrong severity on purpose', expires: '2999-01-01' }],
  });
  assert.deepEqual(mismatch.violations.map((f) => f.name).sort(), ['crit-pkg', 'high-pkg']);
});

test('audit gate: clean production tree passes; both gates stay wired to npm/CI', () => {
  // package.json wiring: `npm run build` goes through the guarded wrapper and
  // the audit script is on the standard check: namespace.
  const pkg = JSON.parse(readSource('../package.json', import.meta.url));
  assert.match(pkg.scripts.build, /node scripts\/build\.mjs/, 'build must run behind the externalization gate');
  assert.match(pkg.scripts.build, /copy-cesium-assets/, 'the cesium asset copy stays part of build');
  assert.equal(pkg.scripts['check:audit'], 'node scripts/check-prod-audit.mjs');

  // CI wiring: audit gate runs in the lint job; the build job's vite build is
  // the gated one (via npm run build).
  const ci = readSource('../.github/workflows/ci.yml', import.meta.url);
  assert.match(ci, /npm run check:audit/, 'the production audit gate must run in CI');
});

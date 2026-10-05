import assert from 'node:assert/strict';
import test from 'node:test';
import {VERDICT,assetRefs,compareAssets,exitCodeFor,pageUrl,parseWranglerTarget,report,verdictFor} from '../scripts/check-deployment.mjs';

const TOML = `name = "protogen-webxr-demo"\npages_build_output_dir = "dist"\ncompatibility_date = "2026-09-17"\n`;

test('a wrangler target yields the project, output directory and public URL', () => {
  assert.deepEqual(parseWranglerTarget(TOML), { name: 'protogen-webxr-demo', output: 'dist', url: 'https://protogen-webxr-demo.pages.dev' });
  // electrical demos publishes from a non-default directory.
  assert.equal(parseWranglerTarget(`name = "trojan-battery-lab"\npages_build_output_dir = "dist-realism"\n`).output, 'dist-realism');
  assert.equal(parseWranglerTarget(`name = "x"\n`).output, 'dist', 'dist is the Pages default');
});

test('no wrangler config means not deployed, not an error', () => {
  assert.equal(parseWranglerTarget(null), null);
  assert.equal(parseWranglerTarget(''), null);
  assert.equal(parseWranglerTarget('compatibility_date = "2026-09-17"\n'), null, 'a config without a name names no project');
});

test('entry pages map to the URLs Cloudflare actually serves', () => {
  const base = 'https://trojan-battery-lab.pages.dev';
  // Pages 308-redirects /solar.html to /solar; request the form it settles on.
  assert.equal(pageUrl(base, 'solar.html'), 'https://trojan-battery-lab.pages.dev/solar');
  assert.equal(pageUrl(base, 'index.html'), 'https://trojan-battery-lab.pages.dev/');
  assert.equal(pageUrl(base, 'dist/sub/page.html'), 'https://trojan-battery-lab.pages.dev/page');
});

test('asset references are extracted from real built markup', () => {
  const html = `<script type="module" crossorigin src="/assets/solar-CygnaVvK.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/RoundedBoxGeometry-zGwYdJWp.js">
    <link rel="stylesheet" href="/assets/solar-DeQ-5PVE.css">`;
  assert.deepEqual([...assetRefs(html)].sort(), ['assets/RoundedBoxGeometry-zGwYdJWp.js', 'assets/solar-CygnaVvK.js', 'assets/solar-DeQ-5PVE.css']);
  assert.equal(assetRefs('').size, 0);
  assert.equal(assetRefs(undefined).size, 0);
});

test('identical hash sets match; any difference is reported with a direction', () => {
  const local = assetRefs('<script src="/assets/index-D1UbBLhH.js"></script><link href="/assets/index-BXX68xkA.css">');
  assert.equal(compareAssets(new Set(local), local).match, true);

  const olderLive = assetRefs('<script src="/assets/index-OLDHASH0.js"></script><link href="/assets/index-BXX68xkA.css">');
  const diff = compareAssets(olderLive, local);
  assert.equal(diff.match, false);
  assert.deepEqual(diff.missing, ['assets/index-D1UbBLhH.js'], 'the local build has a file the live site does not');
  assert.deepEqual(diff.extra, ['assets/index-OLDHASH0.js'], 'the live site serves a file this build did not produce');
});

test('a down page outranks a stale one, and every page counts', () => {
  const good = { status: 200, assets: { match: true, missing: [], extra: [] } };
  const staleAssets = { status: 200, assets: { match: false, missing: ['assets/a.js'], extra: [] } };
  const missing = { status: 404, assets: { match: true, missing: [], extra: [] } };
  assert.equal(verdictFor([good, good]), VERDICT.ok);
  // A multi-entry site where only the second page drifted must not pass on the strength of the first.
  assert.equal(verdictFor([good, staleAssets]), VERDICT.stale);
  assert.equal(verdictFor([good, missing]), VERDICT.down);
  assert.equal(verdictFor([missing, staleAssets]), VERDICT.down, 'unreachable is the more urgent finding');
});

test('exit codes make the check usable as a gate', () => {
  assert.equal(exitCodeFor(VERDICT.ok), 0);
  assert.equal(exitCodeFor(VERDICT.notDeployed), 0, 'the template publishing nowhere is not a failure');
  assert.equal(exitCodeFor(VERDICT.down), 1);
  assert.equal(exitCodeFor(VERDICT.stale), 1);
  assert.equal(exitCodeFor(VERDICT.noBuild), 1);
});

test('an undeployed workspace reports why, and claims nothing about freshness', () => {
  const lines = report({ label: 'WebXR Template', verdict: VERDICT.notDeployed, pages: [] }).join('\n');
  assert.match(lines, /not deployed/);
  assert.match(lines, /intentional for the template/);
  assert.ok(!/assets/.test(lines));
  assert.ok(!/npm run deploy/.test(lines), 'nothing to publish, so no publish instruction');
});

test('a stale report names the differing reference and never deploys on its own', () => {
  const lines = report({
    label: 'electrical demos',
    verdict: VERDICT.stale,
    target: { url: 'https://trojan-battery-lab.pages.dev', name: 'trojan-battery-lab', output: 'dist-realism' },
    pages: [{ file: 'solar.html', url: 'https://trojan-battery-lab.pages.dev/solar', status: 200, assets: { match: false, missing: ['assets/solar-NEW.js'], extra: ['assets/solar-OLD.js'] } }],
    buildStale: { built: new Date('2026-09-16T00:00:00Z'), source: new Date('2026-09-17T00:00:00Z') },
    localCommit: 'fcfc37b',
    deployedCommit: 'e2e3d13',
  }).join('\n');
  assert.match(lines, /assets DIFFER/);
  assert.match(lines, /local has assets\/solar-NEW\.js/);
  assert.match(lines, /live has assets\/solar-OLD\.js/);
  assert.match(lines, /Local build is older than its sources/, 'a stale build invalidates the comparison and must be surfaced');
  assert.match(lines, /rebuild before trusting it/);
  assert.match(lines, /e2e3d13.*fcfc37b.*differs/s);
  assert.match(lines, /To publish: npm run build && npm run deploy/, 'the command is printed, not run');
});

test('a healthy report states the match and omits the publish instruction', () => {
  const lines = report({
    label: 'WebXR Demo',
    verdict: VERDICT.ok,
    target: { url: 'https://protogen-webxr-demo.pages.dev', name: 'protogen-webxr-demo', output: 'dist' },
    pages: [{ file: 'index.html', url: 'https://protogen-webxr-demo.pages.dev/', status: 200, assets: { match: true, missing: [], extra: [] } }],
    buildStale: false,
    localCommit: 'fcfc37b',
    deployedCommit: 'fcfc37b',
  }).join('\n');
  assert.match(lines, /assets match the local build/);
  assert.ok(!/differs/.test(lines));
  assert.ok(!/npm run deploy/.test(lines));
});

test('an unreachable page reports the failure without a meaningless asset diff', () => {
  const lines = report({
    label: 'downtest',
    verdict: VERDICT.down,
    target: { url: 'https://protogen-nonexistent-site-xyz.pages.dev' },
    pages: [{ file: 'index.html', url: 'https://protogen-nonexistent-site-xyz.pages.dev/', status: 0, error: 'fetch failed', assets: { match: false, missing: ['assets/index-AAAA1111.js'], extra: [] } }],
  }).join('\n');
  assert.match(lines, /ERR .* fetch failed/);
  // Nothing was served, so "live does not have X" would only restate the fetch failure.
  assert.ok(!/live does not/.test(lines));
});

test('a missing deployment commit is admitted rather than guessed', () => {
  const lines = report({ label: 'X', verdict: VERDICT.ok, target: { url: 'https://x.pages.dev' }, pages: [], deployedCommit: null, localCommit: 'abc1234' }).join('\n');
  assert.match(lines, /Deployed commit unavailable/);
});

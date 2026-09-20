import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brandMarkSourceFiles,
  checkBrandMarks,
  scanBrandMarks,
} from '../../scripts/check-brand-marks.mjs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('scanBrandMarks collapses picture/source/img and span/img into one mark each', () => {
  const picture =
    '<picture class="brand-wordmark-logo" aria-hidden="true"><source srcset="/brand/logo-dark.svg" media="(prefers-color-scheme: light)" /><img src="/brand/logo-light.svg" alt="" /></picture>';
  const span =
    '<span class="title-logo brand-logo" data-brand-mark="mark" data-logo-gaze data-logo-src="/brand/mark-light.svg" aria-hidden="true"><img src="/brand/mark-light.svg" alt="" /></span>';
  assert.equal(scanBrandMarks(picture).length, 1);
  assert.equal(scanBrandMarks(picture)[0].hasAttribute, false);
  assert.equal(scanBrandMarks(span).length, 1);
  assert.equal(scanBrandMarks(span)[0].hasAttribute, true);
  assert.equal(scanBrandMarks(picture + '\n' + span).length, 2);
});

test('scanBrandMarks ignores favicons, manifests and og:image metadata', () => {
  const head =
    '<link rel="icon" type="image/svg+xml" href="/brand/mark.svg" />\n<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />\n<meta property="og:image" content="/brand/og-image.png" />\n<img src="/brand/icons/link.svg" alt="" />';
  assert.deepEqual(scanBrandMarks(head), []);
});

test('checkBrandMarks reports duplicates per file and marks without data-brand-mark', () => {
  const { violations, marks } = checkBrandMarks([
    {
      file: 'two.html',
      text: '<span class="brand-logo" data-brand-mark="a"><img src="/brand/mark-light.svg" alt=""/></span><img class="brand-logo" data-brand-mark="b" src="/brand/mark-dark.svg" alt=""/>',
    },
    { file: 'bare.html', text: '<img src="/brand/logo-black.svg" alt="" />' },
    {
      file: 'ok.html',
      text: '<span class="brand-logo" data-brand-mark="mark"><img src="/brand/mark-light.svg" alt=""/></span>',
    },
    { file: 'none.html', text: '<p>no brand here</p>' },
  ]);
  assert.equal(marks['two.html'].length, 2);
  assert.equal(marks['bare.html'].length, 1);
  assert.equal(marks['ok.html'].length, 1);
  assert.equal('none.html' in marks, false);
  assert.equal(violations.length, 2, violations.join('\n'));
  assert.match(
    violations[0],
    /^two\.html: renders 2 brand marks \(lines 1, 1\)/,
  );
  assert.match(
    violations[1],
    /^bare\.html:1: brand mark <img> is rendered without data-brand-mark/,
  );
});

test('the repository passes the brand-mark boundary (one tagged mark per header surface)', () => {
  const records = brandMarkSourceFiles(REPO_ROOT);
  const { violations, marks } = checkBrandMarks(records);
  assert.deepEqual(violations, [], violations.join('\n'));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(marks).map(([file, found]) => [file, found.length]),
    ),
    {
      'src/ui/templates/hud-loading.html': 1,
      'src/ui/templates/scene-chrome.html': 1,
    },
  );
});

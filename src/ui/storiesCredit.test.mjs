import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { creditPlacement, entryPlacement } from '../stories/format.js';

const css = readFileSync(
  new URL('./styles/stories.css', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
const view = readFileSync(
  new URL('./views/StoriesView.vue', import.meta.url),
  'utf8',
);

/** Every declaration block in stories.css whose selector names the credit line. */
function creditBlocks() {
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(css));) {
    if (m[1].includes('#cesium-credits'))
      blocks.push({ selector: m[1].trim(), body: m[2] });
  }
  return blocks;
}

test('Stories never hides GEV’s required credit line', () => {
  const blocks = creditBlocks();
  assert.ok(blocks.length > 0, 'Stories places the credit line');
  for (const { selector, body } of blocks) {
    assert.doesNotMatch(
      body,
      /\b(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d]))/,
      selector,
    );
  }
  // The rule that hides GEV's chrome while Stories is open exempts the credit.
  assert.match(
    css,
    /body\.stories-mode\s*>\s*:not\([^)]*\[id='cesium-credits'\]/,
  );
});

test('a playing scene’s recording mode cannot move the credit under the timeline', () => {
  const placement = creditBlocks().find(
    ({ selector, body }) =>
      /^body\.stories-mode:not\(#gs-a\):not\(#gs-b\)\s+#cesium-credits$/.test(
        selector,
      ) && /bottom\s*:/.test(body),
  );
  assert.ok(placement, 'Stories pins the credit line');
  // Two ids outrank body.recording-mode #cesium-credits and the phone shell's
  // !important rule (one id each), so the measured place holds while playing.
  assert.match(
    placement.body,
    /bottom:\s*var\(--gs-credit-bottom,\s*\d+px\)\s*!important/,
  );
  assert.match(
    placement.body,
    /left:\s*var\(--gs-credit-left,\s*\d+px\)\s*!important/,
  );
});

test('the measured place keeps the credit inside the map and on screen', () => {
  const rect = (left, top, right, bottom) => ({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  });
  // Story, desktop: the map ends 80 px above the window's bottom (timeline).
  assert.deepEqual(
    creditPlacement({ map: rect(0, 60, 1200, 720), width: 1200, height: 800 }),
    { bottom: 86, left: 24 },
  );
  // Explore, desktop: the feed covers the map's left, so the credit clears it.
  assert.deepEqual(
    creditPlacement({
      map: rect(0, 0, 1200, 800),
      feed: rect(0, 60, 420, 800),
      width: 1200,
      height: 800,
    }),
    { bottom: 6, left: 434 },
  );
  // Explore, phone: the feed is a sheet below the map, not beside it.
  assert.deepEqual(
    creditPlacement({
      map: rect(0, 0, 390, 360),
      feed: rect(0, 360, 390, 844),
      width: 390,
      height: 844,
    }),
    { bottom: 490, left: 10 },
  );
  // A map taller than the window never pushes the credit off screen.
  assert.equal(
    creditPlacement({ map: rect(0, 0, 800, 900), width: 800, height: 700 })
      .bottom,
    6,
  );
  // No map (Stories closing): GEV's own placement applies.
  assert.equal(creditPlacement({ map: null, width: 800, height: 700 }), null);
  // Closing Stories hands the credit back to GEV.
  assert.match(view, /root\.removeProperty\('--gs-credit-bottom'\)/);
  assert.match(view, /root\.removeProperty\('--gs-credit-left'\)/);
});

test('the Stories button sits left of whatever is in the top-right corner', () => {
  const box = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  // GEV: the ACTIVE STYLE readout.
  assert.deepEqual(entryPlacement([box(1700, 24, 220, 60), undefined], 1960), {
    top: 24,
    right: 270,
  });
  // GEV Hosted: the account avatar beside the readout; the leftmost wins.
  assert.deepEqual(
    entryPlacement([box(1650, 24, 220, 60), box(1898, 22, 38, 38)], 1960),
    { top: 24, right: 320 },
  );
  // Hosted with the readout hidden: the avatar alone.
  assert.deepEqual(
    entryPlacement([box(0, 0, 0, 0), box(1898, 22, 38, 38)], 1960),
    { top: 22, right: 72 },
  );
  // Nothing there yet.
  assert.deepEqual(entryPlacement([null, null], 1960), { top: 14, right: 14 });
});

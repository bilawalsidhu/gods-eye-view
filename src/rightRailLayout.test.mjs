import './testSupport/registerDom.mjs';
import { layoutRightPanelRail } from './ui/rightPanelRail.js';
import { readStylesheet } from './testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('desktop side rails hide collapsed panels in every HUD layout, never on phones or beside Cockpit', () => {
  const right = readFileSync(
    new URL('./ui/rightPanelRail.js', import.meta.url),
    'utf8',
  );
  const left = readFileSync(
    new URL('./ui/leftPanelRail.js', import.meta.url),
    'utf8',
  );
  const css = readStylesheet(new URL('../style.css', import.meta.url));
  for (const ui of [right, left]) {
    assert.match(
      ui,
      /const isMobile = windowRef\.matchMedia\('\(max-width: 720px\)'\)\.matches/,
    );
    assert.match(
      ui,
      /if \(exclusive && panel\.classList\.contains\('collapsed'\)\)\s*panel\.setAttribute\('aria-hidden', 'true'\)/,
    );
    assert.doesNotMatch(ui, /hud\.variant === 'cyber'/);
  }
  assert.match(right, /const exclusive = !isMobile;/);
  // Cockpit keeps its collapsed Data Layers strip, which its layout aligns to.
  assert.match(
    left,
    /const exclusive =\s*!isMobile && !documentRef\?\.body\?\.classList\?\.contains\('cockpit-mode'\);/,
  );
  assert.match(
    css,
    /#right-context-rail\.layout-exclusive > \[data-panel-id\]\.collapsed \{/,
  );
  assert.match(
    css,
    /#left-panel-stack\.layout-exclusive > \[data-panel-id\]\.collapsed \{/,
  );
});

test('the right column keeps room under Context for the dock and the mini player', () => {
  const source = readFileSync(
    new URL('./ui/rightPanelRail.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /stack\.dataset\.cornerReserve/);
  assert.match(source, /const safeBottom = layout\.safeBottom - reserve;/);
  // In the column the dock is that room, not an obstacle the column stops
  // above.
  const controller = readFileSync(
    new URL('./ui/panelLayoutController.js', import.meta.url),
    'utf8',
  );
  assert.match(
    controller,
    /'\.context-corner:not\(\.context-corner--column\)'/,
  );
});

test('a lone panel lines up with the left column when it fits, else reaches up under the top-right row, over the rail gutter, and drops its edge switch', () => {
  const source = readFileSync(
    new URL('./ui/rightPanelRail.js', import.meta.url),
    'utf8',
  );
  // Level with the left column while nothing is docked and it fits there;
  // up under the top-right row otherwise, leaving that with a margin.
  assert.match(source, /let layout = layoutFrom\(alignedTop\);/);
  assert.match(
    source,
    /reserve === 0 && naturalHeight \+ margin <= layout\.maxHeight/,
  );
  assert.match(source, /if \(!fitsAligned\) layout = layoutFrom\(0\);/);
  const controller = readFileSync(
    new URL('./ui/panelLayoutController.js', import.meta.url),
    'utf8',
  );
  assert.match(controller, /'#gev-stories \.gs-entry'/);
  const css = readFileSync(
    new URL('./ui/styles/panel-edge.css', import.meta.url),
    'utf8',
  );
  assert.match(
    css,
    /#right-context-rail:has\(\.ui-rail--sole-open\)\s*> \.panel-collapsible:not\(\.collapsed\)\s*\.panel-header\s*\.ui-panel-edge\.panel-edge-btn \{\s*display: none;/,
  );
});

test('the sole-open Context lane reserves its outer gutter in both reading directions', () => {
  const stack = document.createElement('div');
  stack.innerHTML =
    '<nav class="ui-rail--sole-open"></nav><section data-panel-id id="global-context-panel"></section>';
  stack.style.setProperty('--panel-rail-clearance', '48px');
  stack.getBoundingClientRect = () => ({ left: 100, right: 400 });
  const obstacle = document.createElement('div');
  const gap = 12;
  const originalDirection = document.documentElement.dir;
  try {
    for (const [direction, outer, inner] of [
      ['ltr', 420, 80],
      ['rtl', 80, 420],
    ]) {
      document.documentElement.dir = direction;
      for (const [x, expectedTop] of [
        [outer, 350 + gap],
        [inner, 260],
      ]) {
        obstacle.getBoundingClientRect = () => ({
          left: x,
          right: x + 5,
          top: 300,
          bottom: 350,
          width: 5,
          height: 50,
        });
        layoutRightPanelRail({
          stack,
          obstacles: [obstacle],
          windowRef: {
            innerHeight: 1000,
            matchMedia: () => ({ matches: false }),
          },
          hud: { visible: true, variant: 'minimal' },
          readDisplayScrollTop: () => 0,
          getComputedStyle: (node) => ({
            display: 'block',
            opacity: '1',
            getPropertyValue: (key) => node.style.getPropertyValue(key),
          }),
        });
        assert.equal(
          Number(stack.dataset.safeTop),
          expectedTop,
          direction + ' x=' + x,
        );
      }
    }
  } finally {
    document.documentElement.dir = originalDirection;
  }
});

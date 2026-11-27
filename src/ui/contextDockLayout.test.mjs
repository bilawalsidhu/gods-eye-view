import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { styleFixture } from '../testSupport/styleFixture.mjs';

function fixture(t) {
  document.documentElement.style.cssText =
    '--context-dock-width: 400px; --tactical-hud-bottom: 40px';
  document.body.className = 'panels-edge-right';
  const css = styleFixture(
    t,
    [
      'foundation',
      'stories-entry',
      'layers',
      'context-dock',
      'panel-edge',
      'rail-split',
    ],
    `
    <div id="style-indicator"></div>
    <div id="gev-stories"><button class="gs-entry"></button></div>
    <div id="intel-hud" data-variant="tactical"><div class="hud-bottom-right"></div></div>
    <div id="right-context-rail"><section id="global-context-panel">
      <div class="global-context-panel-inner"></div><div class="panel-glow"></div>
    </section></div>`,
  );
  t.after(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.classList.remove('hud-tactical-active');
    document.body.className = '';
  });
  return css;
}

test('the expanded Context column clears the top row and fills the remaining height', (t) => {
  const css = fixture(t);
  document.body.classList.add('context-docked');
  const dock = css('#right-context-rail');
  const rowBottom =
    parseFloat(css('#style-indicator').top) +
    parseFloat(css('.gs-entry').height);
  assert.ok(parseFloat(dock.top) >= rowBottom + 8);
  assert.equal(dock.bottom, '0px');
  assert.equal(
    dock.height.replaceAll(' ', ''),
    `calc(${window.innerHeight}px-${dock.top}-0px)`,
  );
});

test('expanded Context shares the active desktop readout inset and otherwise reaches the viewport floor', (t) => {
  const css = fixture(t);
  document.body.classList.add('context-docked');
  document.documentElement.classList.add('hud-tactical-active');
  const bottom = css('.hud-bottom-right').bottom;
  assert.equal(bottom, '40px');
  assert.equal(css('#right-context-rail').bottom, bottom);
  for (const mode of [
    'mobile-shell',
    'cockpit-mode',
    'scene-playback-mode',
    'ui-clean-view',
    'recording-mode',
  ]) {
    document.body.classList.add(mode);
    assert.equal(css('#right-context-rail').bottom, '0px', mode);
    document.body.classList.remove(mode);
  }
});

test('expanding Context cancels its gutter shift and keeps the panel finish', (t) => {
  const css = fixture(t);
  const finish = () =>
    ['background', 'border', 'borderRadius', 'boxShadow'].map(
      (property) => css('.global-context-panel-inner')[property],
    );
  const ordinary = finish();
  const glow = () =>
    ['display', 'background', 'opacity', 'boxShadow'].map(
      (property) => css('.panel-glow')[property],
    );
  const ordinaryGlow = glow();
  assert.match(css('#global-context-panel').transform, /translate/);
  document.body.classList.add('context-docked');
  // Rebuild the subtree so Happy DOM recomputes deeply nested styles.
  const rail = document.querySelector('#right-context-rail');
  rail.replaceWith(rail.cloneNode(true));
  const column = css('#right-context-rail');
  assert.ok(['0px', '0'].includes(column.right));
  assert.equal(column.width, '400px');
  assert.equal(css('#global-context-panel').width, '100%');
  assert.equal(css('#global-context-panel').transform, 'none');
  assert.equal(css('.global-context-panel-inner').height, '100%');
  assert.deepEqual(finish(), ordinary);
  assert.deepEqual(glow(), ordinaryGlow);
});

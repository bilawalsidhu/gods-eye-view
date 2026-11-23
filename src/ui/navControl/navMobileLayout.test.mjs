import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nav = readFileSync(new URL('./navControl.css', import.meta.url), 'utf8');
const shell = readFileSync(
  new URL('../styles/mobile-shell.css', import.meta.url),
  'utf8',
);

test('look grid retains physical left and right under RTL locales', () => {
  assert.match(nav, /\.gev-nav-look\s*\{[^}]*\bdirection:\s*ltr\s*;/);
  assert.match(nav, /\.gev-nav-look-left\s*\{\s*grid-area:\s*2\s*\/\s*1\s*;/);
  assert.match(nav, /\.gev-nav-look-right\s*\{\s*grid-area:\s*2\s*\/\s*3\s*;/);
});

test('phone nav clears the shared safe-area-aware switcher bottom and measured height', () => {
  assert.match(
    shell,
    /--mobile-bottom-inset:\s*env\(safe-area-inset-bottom, 0px\)/,
  );
  assert.match(
    shell,
    /--mobile-tab-space:\s*calc\(\s*var\(--mobile-tab-height\) \+ var\(--mobile-bottom-inset\)/,
  );
  assert.match(
    shell,
    /--mobile-view-switcher-bottom:\s*calc\(\s*var\(--mobile-tab-space\) \+ 10px \+ var\(--mobile-voice-height\) \+ 10\.4px\s*\)/,
  );
  assert.match(
    shell,
    /body\.mobile-shell:not\(\.cockpit-mode\) #view-switcher\s*\{[^}]*bottom: calc\(var\(--mobile-view-switcher-bottom\) \+ var\(--world-timeline-lift, 0px\)\)/,
  );
  assert.match(
    nav,
    /body\.mobile-shell \.gev-nav\s*\{\s*bottom: calc\(\s*var\(--mobile-view-switcher-bottom\) \+\s*var\(--world-timeline-lift, 0px\) \+\s*var\(--mobile-view-switcher-height, 0px\) \+ 8px\s*\)/,
  );
});

test('phone voice and switcher share a root-font-relative height', () => {
  assert.match(shell, /--mobile-voice-height:\s*5\.35rem;/);
  assert.match(
    shell,
    /body\.mobile-shell #command-dock #gev-voice-control\s*\{[^}]*height: var\(--mobile-voice-height\);/,
  );
});

test('phone sheets hide navigation rather than covering interactive buttons', () => {
  assert.match(
    nav,
    /body\.mobile-shell\[data-mobile-sheet\] \.gev-nav\s*\{\s*display: none !important;/,
  );
});

test('short landscape phones use a switcher row and center nav clear of top actions', () => {
  assert.match(
    shell,
    /@media \(orientation: landscape\) and \(max-height: 450px\)\s*\{\s*body\.mobile-shell:not\(\.cockpit-mode\) #view-switcher\s*\{\s*grid-auto-flow: column;/,
  );
  assert.match(
    nav,
    /@media \(orientation: landscape\) and \(max-height: 450px\)\s*\{\s*body\.mobile-shell \.gev-nav\s*\{[^}]*right: 50%;\s*transform: translateX\(50%\);/,
  );
});

test('tablet and desktop nav rules carry the timeline lift; exclusive modes hide it', () => {
  assert.match(
    nav,
    /@media \(max-width: 900px\)\s*\{\s*\.gev-nav\s*\{\s*right: 12px;\s*bottom: calc\(2vh \+ 7\.5rem \+ var\(--world-timeline-lift, 0px\)\);/,
  );
  assert.match(
    nav,
    /@media \(min-width: 901px\)\s*\{\s*\.gev-nav\s*\{\s*bottom: calc\(\s*max\(58px, calc\(env\(safe-area-inset-bottom, 0px\) \+ 58px\)\) \+\s*var\(--world-timeline-lift, 0px\)\s*\);/,
  );
  assert.match(
    nav,
    /body:is\(\.cockpit-mode, \.scene-playback-mode, \.recording-mode, \.ui-clean-view\)\s*\.gev-nav\s*\{\s*display: none !important;/,
  );
});

test('every nav placement follows the world-timeline lift and short phones cap it', () => {
  // Each base placement (desktop, tablet, phone) must carry the lift the
  // dock uses, so the raised dock never covers the control.
  const lifted = nav.match(/var\(--world-timeline-lift, 0px\)/g) ?? [];
  assert.ok(lifted.length >= 4, `expected lift in 4 nav offsets, got ${lifted.length}`);
  assert.match(
    nav,
    /max-height: 450px\)\s*\{\s*body\.mobile-shell \.gev-nav\s*\{[^}]*bottom: min\([\s\S]*?calc\(100dvh - 130px - var\(--mobile-top-inset, 0px\)\)/,
  );
});

test('short landscape phones hide the nav while the world timeline is showing', () => {
  assert.match(
    nav,
    /max-height: 450px\)\s*\{[\s\S]*?body\.mobile-shell:has\(#world-timeline\) \.gev-nav\s*\{\s*display: none;/,
  );
});

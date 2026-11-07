import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nav = readFileSync(new URL('./navControl.css', import.meta.url), 'utf8');
const shell = readFileSync(
  new URL('../styles/mobile-shell.css', import.meta.url),
  'utf8',
);

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
    /body\.mobile-shell:not\(\.cockpit-mode\) #view-switcher\s*\{[^}]*bottom: var\(--mobile-view-switcher-bottom\)/,
  );
  assert.match(
    nav,
    /body\.mobile-shell \.gev-nav\s*\{\s*bottom: calc\(\s*var\(--mobile-view-switcher-bottom\) \+\s*var\(--mobile-view-switcher-height, 0px\) \+ 8px\s*\)/,
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

test('tablet, desktop and exclusive modes retain their existing nav rules', () => {
  assert.match(
    nav,
    /@media \(max-width: 900px\)\s*\{\s*\.gev-nav\s*\{\s*right: 12px;\s*bottom: calc\(2vh \+ 7\.5rem\);/,
  );
  assert.match(
    nav,
    /@media \(min-width: 901px\)\s*\{\s*\.gev-nav\s*\{\s*bottom: max\(58px, calc\(env\(safe-area-inset-bottom, 0px\) \+ 58px\)\);/,
  );
  assert.match(
    nav,
    /body:is\(\.cockpit-mode, \.scene-playback-mode, \.recording-mode, \.ui-clean-view\)\s*\.gev-nav\s*\{\s*display: none !important;/,
  );
});

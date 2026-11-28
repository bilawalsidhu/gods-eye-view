import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(
  new URL('./styles/mobile-shell.css', import.meta.url),
  'utf8',
)
  .replace(/\s+/g, ' ')
  .replace(/\( /g, '(')
  .replace(/ \)/g, ')');

const landscape = css.slice(
  css.indexOf('@media (max-height: 520px) and (orientation: landscape)'),
);

test('the phone chrome clears a landscape notch on either side', () => {
  assert.match(css, /--mobile-left-inset: env\(safe-area-inset-left, 0px\)/);
  assert.match(css, /--mobile-right-inset: env\(safe-area-inset-right, 0px\)/);
  assert.match(
    css,
    /#title-bar \{[^}]*inset-inline-start: calc\(var\(--mobile-inline-start-inset\) \+ 14px\)/,
  );
  // Sheets pad their content clear of both insets.
  assert.match(
    css,
    /padding: 14px calc\(var\(--mobile-right-inset\) \+ 10px\) 10px calc\(var\(--mobile-left-inset\) \+ 10px\);/,
  );
  assert.match(
    css,
    /#view-switcher \{[^}]*right: calc\(var\(--mobile-right-inset\) \+ 12px\)/,
  );
});

test('panel glows stay inside a scrolling sheet', () => {
  assert.match(
    css,
    /body\.mobile-shell #left-panel-stack \.panel-glow, body\.mobile-shell #right-context-rail \.panel-glow \{ inset: 0; \}/,
  );
});

test('landscape sizing applies to short landscape screens only', () => {
  // A short portrait viewport (390x500) keeps the portrait shell.
  assert.ok(landscape.length > 0);
  assert.doesNotMatch(css, /@media \(max-height: 520px\) \{/);
  // Eligibility is the shared gate in panelRailGeometry.js, not a width query
  // here.
  assert.doesNotMatch(css, /@media \(max-width:/);
  assert.match(landscape, /--mobile-tab-height: 48px/);
  // The shell recomputes the tab space, so the shorter bar moves the sheets.
  assert.match(
    css,
    /body\.mobile-shell \{[^}]*--mobile-tab-space: calc\(var\(--mobile-tab-height\) \+ var\(--mobile-bottom-inset\)\)/,
  );
  assert.match(
    landscape,
    /--mobile-sheet-max-height: min\(62dvh, calc\(100dvh - var\(--mobile-top-inset\) - var\(--mobile-tab-space\) - 70px\)\)/,
  );
});

test('the corner buttons step aside for a landscape sheet', () => {
  assert.match(
    landscape,
    /body\.mobile-shell\[data-mobile-sheet\] #corner-actions, body\.mobile-shell\[data-mobile-sheet\] #gev-stories \.gs-entry \{ visibility: hidden; \}/,
  );
});

test('a landscape phone keeps the dock to a desktop-like width in the middle', () => {
  assert.match(
    landscape,
    /:where\(\.has-omnibar\.dock-has-voice \*\) \{ --omnibar-dock-width: min\(calc\(100vw - 24px - env\(safe-area-inset-left, 0px\) - env\(safe-area-inset-right, 0px\)\), 560px\);/,
  );
  // The landscape rule comes after the phone dock rule, so it wins.
  assert.ok(
    css.indexOf('@media (max-height: 520px) and (orientation: landscape)') >
      css.indexOf(
        '--omnibar-dock-bottom: calc(var(--mobile-tab-space) + 10px)',
      ),
  );
});

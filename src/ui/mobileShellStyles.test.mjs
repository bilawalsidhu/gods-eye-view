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

test('phone presentation follows shell state and accounts for both landscape notches', () => {
  assert.match(css, /--mobile-left-inset: env\(safe-area-inset-left, 0px\)/);
  assert.match(css, /--mobile-right-inset: env\(safe-area-inset-right, 0px\)/);
  assert.match(
    css,
    /body\.mobile-shell \{ --mobile-tab-space: calc\(var\(--mobile-tab-height\) \+ var\(--mobile-bottom-inset\)\)/,
  );
  assert.match(css, /@media \(max-height: 520px\)/);
  assert.match(css, /--mobile-tab-height: 48px/);
  assert.doesNotMatch(css, /@media \(max-width:/);
});

test('phone picker and settings gear override desktop floating offsets at the mic anchor', () => {
  assert.match(
    css,
    /body\.mobile-shell #command-dock > #gev-voice-control\[data-provider-choice='true'\] \{[^}]*--gev-provider-lift: 0px/,
  );
  assert.match(
    css,
    /> \.gev-voice-provider-field:not\(\[hidden\]\) \{[^}]*left: 0;[^}]*right: 0;[^}]*bottom: calc\(100% \+ 8px\)/,
  );
  assert.match(
    css,
    /> \.gev-voice-settings-button \{[^}]*left: auto;[^}]*right: 7px;[^}]*bottom: calc\(100% \+ 15px\)/,
  );
});

test('landscape sheets pin glows inside the scroll box and reserve space above More', () => {
  assert.match(
    css,
    /body\.mobile-shell #left-panel-stack \.panel-glow, body\.mobile-shell #right-context-rail \.panel-glow \{ inset: 0;/,
  );
  assert.match(
    css,
    /--mobile-rail-under-dock-max-height: min\(38dvh, calc\(100dvh - var\(--mobile-tab-space\) - var\(--mobile-top-inset\) - 90px - var\(--mobile-dock-sheet-max-height\)\)\)/,
  );
});

test('phone landscape collapses voice to a corner mic with the chooser beside it', () => {
  const landscape = css.slice(css.indexOf('Phone landscape has no height'));
  assert.match(
    landscape,
    /#gev-voice-control\[data-status='error'\] \{[^}]*width: 3\.4rem;[^}]*height: 3\.4rem;[^}]*border-radius: 50%/,
  );
  assert.match(
    landscape,
    /\.gev-voice-visualizer, [^{]*\.gev-voice-readout, [^{]*\.gev-mic-label \{ display: none;/,
  );
  assert.match(
    landscape,
    /> \.gev-voice-provider-field:not\(\[hidden\]\) \{[^}]*right: calc\(100% \+ 8px\);[^}]*bottom: 50%;[^}]*translate: 0 50%/,
  );
  assert.match(
    landscape,
    /\.gev-voice-error-tray \{[^}]*right: 0;[^}]*left: auto;[^}]*transform: none/,
  );
});

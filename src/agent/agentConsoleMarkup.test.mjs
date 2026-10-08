import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APPLICATION_TEMPLATES,
  expandApplicationHtml,
} from '../../build/application-html.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const template = readFileSync(
  new URL('../ui/templates/agent-console.html', import.meta.url),
  'utf8',
);
const html = expandApplicationHtml(
  readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
);
const css = readStylesheet(new URL('../../style.css', import.meta.url));

test('the console is a registered template and reaches the built document', () => {
  assert.ok(APPLICATION_TEMPLATES.includes('agent-console'));
  assert.match(html, /id="agent-console"/);
  assert.match(html, /id="agent-console-chip"/);
});

test('the console is a dialog on the shared panel surface, opened by its chip', () => {
  // docs/panel-surfaces.md: a dialog owner takes the surface skin and the
  // clean-UI/recording concealment, and owns its own geometry and dismissal.
  assert.match(template, /<dialog id="agent-console" data-panel-surface/);
  assert.doesNotMatch(
    template,
    /<dialog[^>]*panel-collapsible/,
    'the contract forbids panel-collapsible on a dialog',
  );
  assert.match(template, /<header data-panel-header>/);
  assert.match(
    template,
    /id="agent-transcript" data-panel-body data-rail-scroller/,
  );
  assert.match(template, /id="agent-console-chip"[^>]*aria-haspopup="dialog"/);
  assert.match(
    template,
    /id="agent-console-chip"[^>]*aria-controls="agent-console"/,
  );
  assert.match(template, /id="agent-console-chip"[^>]*hidden/);
});

test('the dock disclosure class the dock hides is not borrowed here', () => {
  // The rail example's .panel-collapse-btn is deliberately hidden by dock
  // rules; a dialog owns its own close control instead.
  assert.doesNotMatch(template, /panel-collapse-btn/);
  assert.match(
    template,
    /id="agent-console-close"[^>]*aria-label="Close GEV Command"/,
  );
});

test('every control the console drives has an accessible name', () => {
  for (const pattern of [
    /id="agent-provider"/,
    /id="agent-model"/,
    /id="agent-input"[^>]*aria-label="Typed command"/,
    /id="agent-status"[^>]*role="status"[^>]*aria-live="polite"/,
    /id="agent-transcript"[^>]*aria-label="Command transcript"/,
  ]) {
    assert.match(template, pattern);
  }
  // The two selects are labelled by their visible wrapper label.
  assert.match(
    template,
    /<label class="agent-console-field">\s*<span>PROVIDER<\/span>/,
  );
  assert.match(
    template,
    /<label class="agent-console-field">\s*<span>MODEL<\/span>/,
  );
});

test('the console stylesheet ships, and clears the surfaces that hide chrome', () => {
  assert.match(css, /#agent-console-chip \{/);
  assert.match(css, /#agent-console \{/);
  for (const mode of [
    'ui-clean-view',
    'recording-mode',
    'cockpit-mode',
    'scene-playback-mode',
  ]) {
    assert.match(
      css,
      new RegExp(`body\\.${mode} #agent-console\\b`),
      `the console survives ${mode}`,
    );
    assert.match(css, new RegExp(`body\\.${mode} #agent-console-chip\\b`));
  }
});

test('the console sits below the dialog that configures its own credentials', () => {
  const zIndex = (selector) => {
    const block = new RegExp(
      `${selector} \\{[^}]*?z-index:\\s*(\\d+)`,
      's',
    ).exec(css);
    assert.ok(block, `no z-index for ${selector}`);
    return Number(block[1]);
  };
  assert.ok(zIndex('#agent-console') < zIndex('#key-setup'));
});

test('the chips and the console stack without covering each other', () => {
  // Three fixed surfaces share the bottom-right corner, at two breakpoints:
  // POWER UP owns the corner, the GEV COMMAND chip sits above it, and the
  // open console sits above both so its own toggle stays clickable.
  const bottoms = (selector) =>
    [
      ...css.matchAll(
        new RegExp(`${selector} \\{[^}]*?bottom:\\s*([\\d.]+)rem`, 'gs'),
      ),
    ].map((match) => Number(match[1]));
  const insetBottoms = [
    ...css.matchAll(
      /#agent-console \{[^}]*?inset:\s*auto [\d.]+rem ([\d.]+)rem auto/gs,
    ),
  ].map((match) => Number(match[1]));
  const powerUp = bottoms('#key-setup-chip');
  const chip = bottoms('#agent-console-chip');
  assert.equal(
    powerUp.length,
    2,
    'POWER UP should set a bottom per breakpoint',
  );
  assert.equal(chip.length, 2, 'the chip should set a bottom per breakpoint');
  assert.equal(
    insetBottoms.length,
    2,
    'the console should anchor per breakpoint',
  );
  for (const index of [0, 1]) {
    assert.ok(
      chip[index] > powerUp[index],
      `chip overlaps POWER UP at ${index}`,
    );
    assert.ok(
      insetBottoms[index] > chip[index],
      `console covers its chip at ${index}`,
    );
  }
});

test('the console overrides the dialog insets its UA rules would centre it with', () => {
  assert.match(
    css,
    /#agent-console \{[^}]*?inset:\s*auto [\d.]+rem [\d.]+rem auto/s,
  );
  assert.match(css, /#agent-console \{[^}]*?margin:\s*0/s);
});

test('the template adds no icon glyph, so the font subset stays untouched', () => {
  // src/materialSymbolsSubset.test.mjs fails on a glyph missing from
  // index.html's icon_names; a text caret needs no entry at all.
  assert.doesNotMatch(template, /material-symbols-outlined/);
});

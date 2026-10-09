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

test('the chip and the console sit on the left, clear of each other', () => {
  // The right corner belongs to POWER UP; the console opened over it there.
  // Both now anchor left, and the chip sits below the console, not under it.
  const chipBlock = /#agent-console-chip \{([^}]*)\}/s.exec(css)[1];
  assert.match(chipBlock, /left:\s*[\d.]+rem/);
  assert.doesNotMatch(chipBlock, /\bright:\s*[\d.]+rem/);
  const insets = [
    ...css.matchAll(
      /#agent-console \{[^}]*?inset:\s*auto auto ([\d.]+)rem ([\d.]+)rem/gs,
    ),
  ];
  assert.equal(insets.length, 2, 'the console should anchor per breakpoint');
  const chipBottoms = [
    ...css.matchAll(/#agent-console-chip \{[^}]*?bottom:\s*([\d.]+)rem/gs),
  ].map((match) => Number(match[1]));
  assert.equal(chipBottoms.length, 2);
  for (const index of [0, 1]) {
    assert.ok(
      Number(insets[index][1]) > chipBottoms[index],
      `the console covers its own chip at breakpoint ${index}`,
    );
  }
});

test('the console overrides the dialog insets its UA rules would centre it with', () => {
  assert.match(
    css,
    /#agent-console \{[^}]*?inset:\s*auto auto [\d.]+rem [\d.]+rem/s,
  );
  assert.match(css, /#agent-console \{[^}]*?margin:\s*0/s);
});

test('the console keeps the shared glass surface, and reads as a drag handle', () => {
  // It sits OVER the HUD readouts rather than beside them, so what is behind
  // it is blurred rather than hidden: the surface keeps its shared --glass-bg
  // translucency, and the coordinates underneath stop competing with
  // transcript text.
  const consoleBlock = /#agent-console \{([^}]*)\}/s.exec(css)[1];
  assert.doesNotMatch(
    consoleBlock,
    /background:/,
    'the console overrides the shared translucent surface',
  );
  assert.match(consoleBlock, /backdrop-filter:\s*blur/);
  assert.match(consoleBlock, /-webkit-backdrop-filter:\s*blur/);
  assert.match(
    css,
    /#agent-console > \[data-panel-header\] \{[^}]*?cursor:\s*move/s,
  );
  assert.match(
    css,
    /#agent-console > \[data-panel-header\] \{[^}]*?user-select:\s*none/s,
  );
  assert.match(
    css,
    /#agent-console > \[data-panel-header\] \{[^}]*?touch-action:\s*none/s,
  );
});

test('the console reuses the resize handle styling the app already ships', () => {
  // consoleBox.js creates .panel-resize-edge / .panel-resize-grip rather than
  // a second set of handles, so this stylesheet must not restyle them.
  assert.match(css, /\.panel-resize-edge,\s*\n?\.panel-resize-grip \{/);
  const consoleCss = readStylesheet(
    new URL('../ui/styles/agent-console.css', import.meta.url),
  );
  assert.doesNotMatch(consoleCss, /panel-resize-(edge|grip)/);
});

test('the template adds no icon glyph, so the font subset stays untouched', () => {
  // src/materialSymbolsSubset.test.mjs fails on a glyph missing from
  // index.html's icon_names; a text caret needs no entry at all.
  assert.doesNotMatch(template, /material-symbols-outlined/);
});

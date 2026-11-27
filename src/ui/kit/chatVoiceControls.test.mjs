// The AI chat panel's and the voice control's buttons and Material glyphs
// are the kit's: neither their templates nor the voice card and panel
// layout buttons they render hand-write a <button> or a Material Symbols
// span. Their other glyphs (the chat bubble, the globe, attach, send and
// stop, expand and the two Back chevrons) are inline SVG drawn with their own
// strokes, which no Material symbol the page loads draws the same, so they
// stay SVG. The voice panel's Preview and Settings are tabs (`role="tab"`
// with `aria-selected`), not pressed toggles, and DISMISS is a text button,
// not a cross, so it is a UiButton rather than a UiCloseButton. The chat's
// message box, file picker and the minutes field stay native: the kit has
// no text area, file or number field. The voice modules build no controls
// in script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A view's template block: everything outside script, style and comments. */
function template(file) {
  const source = readFileSync(
    new URL(`../views/panels/${file}`, import.meta.url),
    'utf8',
  );
  return source
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}
// A tag's attributes, read past quoted values so a handler's `=>` does not
// end the tag early.
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tag = (pattern, flags = '') =>
  new RegExp(pattern.replaceAll('ATTRS', ATTRS), flags);
const tags = (markup, name) =>
  markup.match(tag(String.raw`<${name}\bATTRS>`, 'g')) ?? [];

const views = {
  // Settings, the quick prompts, an attachment's remove, Attach layer,
  // Attach a file, Expand conversation, the command suggestions, Expand
  // chat, Add attachment and Send / Stop reply.
  'ChatPanel.vue': {
    UiButton: 10,
    UiCloseButton: 1,
    UiIcon: 1,
    UiSelect: 1,
    svgs: 5,
  },
  // The tier button (dock and panel), the mic, Open AI chat, Back to chat,
  // Back to voice, the Preview and Settings tabs and DISMISS.
  'VoiceControl.vue': {
    UiButton: 9,
    UiCloseButton: 1,
    UiIcon: 2,
    UiSelect: 3,
    UiCheckbox: 2,
    svgs: 3,
  },
  'VoiceCard.vue': { UiButton: 0, UiCloseButton: 1, UiIcon: 0, svgs: 0 },
  // Minimize and expand share one button.
  'PanelLayoutButtons.vue': { UiButton: 1, UiIcon: 0, svgs: 1 },
  'VoiceVisualizer.vue': { UiButton: 0, UiIcon: 0, svgs: 1 },
};
const markup = Object.fromEntries(
  Object.keys(views).map((file) => [file, template(file)]),
);

test('the chat and voice views hand-write no button; each is the kit', () => {
  for (const [file, counts] of Object.entries(views)) {
    assert.deepEqual(markup[file].match(/<button\b/gi) ?? [], [], file);
    for (const name of ['UiButton', 'UiCloseButton', 'UiSelect', 'UiCheckbox'])
      assert.equal(tags(markup[file], name).length, counts[name] ?? 0, file);
  }
});

test('the pressed toggles take the kit pressed state', () => {
  for (const [file, view] of Object.entries(markup))
    assert.doesNotMatch(view, /aria-pressed/, file);
  const voice = tags(markup['VoiceControl.vue'], 'UiButton');
  const tiers = voice.filter((button) => /id="gev-voice-tier"/.test(button));
  assert.equal(tiers.length, 2);
  for (const tier of tiers)
    assert.match(tier, /\s:pressed="Boolean\(view\.tier\.pressed\)"/);
  // The mic writes no aria-pressed while its owner has no state for it.
  assert.match(
    markup['VoiceControl.vue'],
    tag(
      String.raw`<UiButton\s+id="gev-voice-button"ATTRS\s:pressed="view\.button\.pressed \?\? undefined"`,
    ),
  );
  // The panel tabs are tabs: selected, never pressed.
  const tabs = voice.filter((button) => /role="tab"/.test(button));
  assert.equal(tabs.length, 2);
  for (const button of tabs) {
    assert.match(button, /\s:aria-selected="/);
    assert.doesNotMatch(button, /\s:pressed=/);
  }
});

test('the views hand-write no Material glyph; each is a UiIcon the site sizes', () => {
  for (const [file, { UiIcon, svgs }] of Object.entries(views)) {
    assert.deepEqual(markup[file].match(/material-symbols/g) ?? [], [], file);
    const icons = tags(markup[file], 'UiIcon');
    assert.equal(icons.length, UiIcon, file);
    // Without it the kit writes an 18px size that beats voice-cost.css and
    // voice-card.css.
    for (const icon of icons) assert.match(icon, /\s:size="null"/, file);
    assert.equal(markup[file].match(/<svg\b/g)?.length ?? 0, svgs, file);
  }
  assert.match(
    markup['ChatPanel.vue'],
    /<UiIcon name="settings" class="gev-voice-settings-icon" :size="null" \/>/,
  );
  assert.equal(
    markup['VoiceControl.vue'].match(
      /<UiIcon name="(?:visibility|settings)" class="gev-voice-panel-tab-icon" :size="null" \/>/g,
    )?.length,
    2,
  );
});

test('the only native fields left are the message box, file picker and minutes', () => {
  const inputs = Object.values(markup).flatMap((view) => tags(view, 'input'));
  assert.equal(inputs.length, 2);
  assert.match(inputs[0], /id="gev-chat-file" type="file"/);
  assert.match(inputs[1], /id="gev-voice-timeout-input" type="number"/);
  assert.equal(tags(markup['ChatPanel.vue'], 'textarea').length, 1);
  for (const view of Object.values(markup)) {
    assert.deepEqual(view.match(/<select\b/gi) ?? [], []);
    assert.doesNotMatch(view, /type="(?:checkbox|range)"/);
  }
});

test('the voice modules build no buttons or Material glyphs in script', () => {
  const root = fileURLToPath(new URL('../../voice/', import.meta.url));
  const modules = readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith('.js') && !/test|Harness/.test(file))
    .map((file) => path.join(root, file));
  assert.ok(modules.length > 50);
  for (const file of modules) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /createElement\(\s*['"]button/, file);
    assert.doesNotMatch(source, /<button\b|material-symbols/, file);
  }
});

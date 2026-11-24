import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const kit = readFileSync(new URL('./kit.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

test("an icon's glyph stays in its box under a page-wide jQuery UI .ui-icon rule", () => {
  const rule = kit.match(/\.ui-icon\.ui-icon\s*\{([^}]*)\}/);
  assert.ok(rule, 'a doubled class outranks a single-class .ui-icon rule');
  for (const declaration of [
    /text-indent:\s*0/,
    /overflow:\s*visible/,
    /background-image:\s*none/,
    /width:\s*auto/,
    /height:\s*auto/,
  ])
    assert.match(rule[1], declaration);
});

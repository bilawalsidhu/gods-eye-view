import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

// Focused markup guards; actual computed names are checked in Chromium.
// Native labels and hidden inputs must not be treated as missing aria-labels.
test('HUD sliders and location search have descriptive explicit names', () => {
  for (const [id, name] of [
    ['scope-feather-slider', 'Scope edge feather'],
    ['bloom-intensity-slider', 'Bloom intensity'],
    ['sharpen-intensity-slider', 'Sharpen intensity'],
    ['location-search', 'Search location by name or coordinates'],
  ]) {
    const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${id} exists`);
    assert.ok(input.includes(`aria-label="${name}"`), `${id} has its descriptive name`);
  }
});

test('the first-run checkbox keeps its native visible label', () => {
  assert.match(html, /<label\b[^>]*class="first-run-suppress"[^>]*>\s*<input type="checkbox" data-first-run-suppress \/>\s*<span>Don't show this again<\/span>\s*<\/label>/);
});

test('generated style sliders use the visible parameter label as their name', () => {
  assert.match(ui, /label\.textContent\s*=\s*uMeta\.label;/);
  assert.match(ui, /slider\.setAttribute\(['"]aria-label['"],\s*uMeta\.label\)/);
});

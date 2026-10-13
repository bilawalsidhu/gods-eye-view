import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The rail's measuring pass lifts these panel scrollers to their natural
// height, which clamps their scroll offset to zero. Only scrollers tagged
// `data-rail-scroller` get their offset restored afterwards, so every lifted
// scroller must carry the tag or a layout pass snaps it back to the top.
test('every scroller the rail measuring pass lifts restores its scroll offset', () => {
  const css = read('./styles/layers.css');
  const templates = [
    read('./templates/context.html'),
    read('./templates/layer-panels.html'),
  ].join('\n');
  const lifted = [
    ...css.matchAll(
      /#right-context-rail\[data-rail-measuring\]\s*>\s*\[data-panel-id\]:not\(\.collapsed\)\s*>\s*\.([a-z-]+)/g,
    ),
  ].map((match) => match[1]);
  assert.ok(lifted.length > 0, 'measuring CSS lists lifted scrollers');
  for (const className of lifted) {
    const tag = templates.match(
      new RegExp(`<div class="${className}"[^>]*>`),
    )?.[0];
    if (!tag) continue;
    assert.match(tag, /data-rail-scroller/, `${className} restores its scroll`);
  }
});

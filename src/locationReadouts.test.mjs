import { readShellSource } from './testSupport/readShellSource.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const ui = readShellSource();

/** Source of the free-text place search handler (the Omnibar's place lookups). */
function locationSearchHandler() {
  const start = ui.indexOf('  _handleLocationSearchState(state, change) {');
  assert.ok(start > 0, 'free-text location search handler is missing');
  const end = ui.indexOf('_beginWorldJumpTransition() {', start);
  assert.ok(end > start, 'could not bound the location search handler');
  return ui.slice(start, end);
}

test('the ACTIVE STYLE indicator is written from the style name and nothing else', () => {
  // A free-text location search used to write the searched CITY into the
  // top-right style slot, so the corner read "ACTIVE STYLE / TOKYO". The
  // corner renders the style VisualSettings publishes, from one writer.
  const writes = [...ui.matchAll(/\.publishStyle\(/g)];
  assert.equal(writes.length, 1, 'the style indicator must have exactly one writer');
  assert.match(
    ui.slice(writes[0].index, writes[0].index + 200),
    /\.publishStyle\(\{\s*name,\s*label: STYLE_STATUS_LABELS\[name\]\s*\?\s*t\(STYLE_STATUS_LABELS\[name\]\)\s*:\s*name\.toUpperCase\(\),/,
  );

  const handler = locationSearchHandler();
  assert.doesNotMatch(handler, /publishStyle|_publishActiveStyle/, 'location search must not touch the style indicator');
  assert.doesNotMatch(handler, /active-style-name/, 'location search must not touch the style indicator');
});

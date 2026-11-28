import assert from 'node:assert/strict';
import test from 'node:test';

import { bindRenderer } from '../render/rendererOf.js';
import { createMapCredits } from './credits.js';

function viewerWithCredits() {
  const credits = new Set();
  const viewer = {};
  bindRenderer(viewer, {
    credits: {
      addStatic(credit) {
        credits.add(credit);
        return () => credits.delete(credit);
      },
    },
  });
  return { viewer, credits };
}

test("a map source's own credit is listed in Data attribution while it is shown, never on the map", () => {
  const { viewer, credits } = viewerWithCredits();
  const mapCredits = createMapCredits(viewer);
  mapCredits.show('<a href="https://example.com/maps">Example Maps</a>');
  assert.deepEqual(
    [...credits],
    [{ text: 'Example Maps', href: 'https://example.com/maps', inline: false }],
  );
  mapCredits.show(null);
  assert.equal(credits.size, 0);
  mapCredits.destroy();
});

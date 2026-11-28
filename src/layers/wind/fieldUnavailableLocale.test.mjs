// A scalar overlay that cannot be drawn reports a marked English status
// (rendering.js); only known overlays have one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALAR_UNAVAILABLE } from './fields.js';
import { fieldUnavailableText } from './rendering.js';

test('only a known overlay has an unavailable status', () => {
  assert.equal(fieldUnavailableText('constructor'), null);
  assert.equal(fieldUnavailableText('none'), null);
  for (const [overlay, text] of Object.entries(SCALAR_UNAVAILABLE))
    assert.equal(fieldUnavailableText(overlay), text);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderFragmentTracker } from './providerIntentFragments.js';

function classify(segments) {
  const tracker = createProviderFragmentTracker();
  for (const segment of segments) tracker.append(segment);
  return tracker.state();
}

test('full-run fragment retention covers long targets, mid-word splits and commas', () => {
  for (const segments of [
    ['use', 'foo', 'bar', 'baz', 'as', 'my', 'voice', 'provider'],
    ['use', 'Foo', 'as', 'my', 'voi', 'ce provider'],
    ['please', ', use foo', 'as my voice provider'],
    ['use', 'x'.repeat(41), 'as', 'my', 'voi', 'ce', 'provider'],
    ['swi', 'tch', 'to', 'Gem', 'ini'],
    ['use', ' '.repeat(10000) + 'foo', 'as my voice provider'],
  ])
    assert.equal(classify(segments), 'request', JSON.stringify(segments));
});

test('retention viability alone never holds ordinary tools and full compounds resolve', () => {
  assert.equal(classify(['use', 'foo']), 'none');
  assert.equal(classify(['switch', 'to']), 'prefix');
  for (const segments of [
    ['set', 'voice', 'volume', 'to', '50'],
    ['set', 'voice', 'speed', 'to', 'fast'],
    ['set', 'provider', 'to', 'bing maps'],
    ['say', 'use foo as my voice provider'],
    ['"use foo', 'as my voice provider"'],
    ['do not', 'use foo as my voice provider'],
    ['use foo as my voice provider', 'and zoom out'],
    ['use gemini', 'for weather'],
  ])
    assert.equal(classify(segments), 'none', JSON.stringify(segments));
});

test('fragment resources are bounded and overflow stays restrictive', () => {
  const tracker = createProviderFragmentTracker();
  for (let i = 0; i < 80; i++) {
    tracker.append('x');
    assert.ok(tracker.size() <= 256);
  }
  assert.equal(tracker.state(), 'prefix');
});

test('fragment fusion preserves explicit canonical negative and compound boundaries', () => {
  for (const word of ['and', 'or', 'if', 'not', 'unless', 'when', 'then']) {
    assert.equal(
      classify(['use foo', `${word} bar`, 'as my voice provider']),
      'none',
      word,
    );
  }
  assert.equal(
    classify(['use', 'Foo', 'as', 'my', 'voi', 'ce provider']),
    'request',
  );
  assert.equal(classify(['swi', 'tch', 'to', 'Gem', 'ini']), 'request');
});

test('normalized input overflow stays restrictive across later negative captions', () => {
  const tracker = createProviderFragmentTracker();
  assert.equal(
    tracker.append('set voice provider to ' + 'x'.repeat(501)),
    'input-limit',
  );
  assert.equal(tracker.size(), 0);
  assert.equal(tracker.append('not a provider request'), 'input-limit');
  assert.equal(tracker.size(), 0);
  assert.equal(classify([' '.repeat(10000) + 'x'.repeat(500)]), 'none');
  assert.equal(classify(['x'.repeat(501)]), 'input-limit');
});

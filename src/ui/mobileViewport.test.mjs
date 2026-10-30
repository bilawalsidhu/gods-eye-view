import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MOBILE_SHELL_MEDIA_QUERY } from './panelRailGeometry.js';

test('phone shell query bounds short screens without changing tablet or desktop eligibility', () => {
  assert.equal(
    MOBILE_SHELL_MEDIA_QUERY,
    '(max-width: 720px), (max-width: 1023px) and (max-height: 520px)',
  );
});

test('shell and both rail engines consume the same phone query', () => {
  for (const file of [
    'mobileShell.js',
    'leftPanelRail.js',
    'rightPanelRail.js',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(
      source,
      /import \{[^}]*MOBILE_SHELL_MEDIA_QUERY[^}]*\} from '\.\/panelRailGeometry\.js'/,
    );
    assert.match(source, /matchMedia\(MOBILE_SHELL_MEDIA_QUERY\)/);
    assert.doesNotMatch(source, /matchMedia\(['"`]/);
  }
});

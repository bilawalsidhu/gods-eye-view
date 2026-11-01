import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const launcher = readFileSync(
  new URL('../Launch Gods Eye View.bat', import.meta.url),
  'utf8',
);

test('Windows launcher fast-forwards a clean main checkout without rewriting it', () => {
  assert.match(launcher, /git branch --show-current/);
  assert.match(launcher, /git status --porcelain/);
  assert.match(launcher, /git fetch origin main/);
  assert.match(launcher, /git merge --ff-only origin\/main/);
  assert.match(launcher, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.doesNotMatch(launcher, /git (?:reset|checkout|switch|rebase)\b/);
});

test('Windows launcher reinstalls dependencies after upstream manifest changes', () => {
  assert.match(
    launcher,
    /git diff --quiet HEAD origin\/main -- package\.json package-lock\.json/,
  );
  assert.match(launcher, /call npm ci/);
});

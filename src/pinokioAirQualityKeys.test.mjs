import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PINOKIO_CONFIG_FIELDS,
  applyPinokioEnvironment,
} from '../scripts/pinokio-environment.mjs';

const NEW_KEYS = ['OPENAQ_API_KEY'];

test('Pinokio app scope owns the air-quality keys', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aq-pinokio-'));
  try {
    const filepath = path.join(dir, 'ENVIRONMENT');
    // The app's own value is blank (Pinokio drops blank entries, so a
    // Pinokio-global value would otherwise reach the child).
    writeFileSync(filepath, 'OPENAQ_API_KEY=\n');
    const environment = { OPENAQ_API_KEY: 'global-placeholder' };
    applyPinokioEnvironment({ environment, filepath });
    for (const name of NEW_KEYS) {
      assert.ok(PINOKIO_CONFIG_FIELDS.includes(name), `${name} app-scoped`);
      assert.equal(
        environment[name],
        '',
        `${name} must not inherit the global value`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

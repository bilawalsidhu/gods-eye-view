import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('the QA rejects invalid subject names before creating its output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-subject-'));
  try {
    const out = path.join(dir, 'qa', 'inner');
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#808080' } })
      .png()
      .toFile(path.join(dir, 'sheet.png'));
    fs.writeFileSync(
      path.join(dir, 'm.json'),
      JSON.stringify({
        image: 'sheet.png', cellPx: 4, columns: 2, rows: 2, ringStepDeg: 7.5,
        rings: Array(13).fill(1), subjects: { '../escaped': { first: 0 } },
      }),
    );
    const result = spawnSync(process.execPath, [
      '--permission', '--allow-fs-read=*', '--allow-addons',
      path.join(repo, 'scripts/qa-aircraft-view-sheet.mjs'),
      '--manifest', path.join(dir, 'm.json'), '--out', out, '--sizes', '4', '--zoom', '1',
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /subject name/);
    assert.equal(fs.existsSync(path.join(dir, 'qa', 'escaped.png')), false);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

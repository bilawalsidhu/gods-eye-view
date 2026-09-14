import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectRoot } from '../scripts/project-root.mjs';
import { inspectSetup } from '../scripts/setup-doctor.mjs';
const run = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

test('tool project paths default to the installation and accept an explicit directory', () => {
  const moduleUrl = pathToFileURL(
    path.join(os.tmpdir(), 'source', 'tools', 'test.mjs'),
  );
  assert.equal(projectRoot(moduleUrl, {}), path.join(os.tmpdir(), 'source'));
  const root = path.join(os.tmpdir(), 'other project');
  assert.equal(projectRoot(moduleUrl, { GEV_PROJECT_ROOT: root }), root);
});

test('doctor inspects the selected project dependencies and dotenv without disclosing values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-doctor-project-'));
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '1' } }),
    );
    await mkdir(path.join(root, 'node_modules', 'fixture'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'node_modules', 'fixture', 'package.json'),
      '{}',
    );
    await writeFile(
      path.join(root, '.env'),
      'GOOGLE_MAPS_SERVER_API_KEY=fixture-server-secret\n',
    );
    const report = inspectSetup({ rootDir: root, includeKeychain: false });
    assert.equal(report.dependenciesInstalled, true);
    assert.equal(
      report.credentials.GOOGLE_MAPS_SERVER_API_KEY.configured,
      true,
    );
    assert.doesNotMatch(JSON.stringify(report), /fixture-server-secret/);
    await rm(path.join(root, 'node_modules'), { recursive: true });
    assert.equal(
      inspectSetup({ rootDir: root, includeKeychain: false })
        .dependenciesInstalled,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const bashTest = process.platform === 'win32' ? test.skip : test;
bashTest(
  'launcher reads the selected project keys and starts its command while source checks use the installation',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gev other project-'));
    try {
      const bin = path.join(root, 'bin');
      await mkdir(bin);
      await writeFile(
        path.join(root, '.env'),
        'GOOGLE_MAPS_API_KEY=fixture-browser\nGOOGLE_MAPS_SERVER_API_KEY=fixture-server\nOPENAI_API_KEY=fixture-voice\n',
      );
      for (const command of ['security', 'pkill', 'lsof']) {
        await writeFile(path.join(bin, command), '#!/bin/sh\nexit 1\n', {
          mode: 0o755,
        });
      }
      const capture = path.join(root, 'capture.json');
      await writeFile(
        path.join(bin, 'npm'),
        `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), browser: process.env.GOOGLE_MAPS_API_KEY, server: process.env.GOOGLE_MAPS_SERVER_API_KEY, voice: process.env.OPENAI_API_KEY, provenance: process.env.GEV_KEY_SETUP_EXTERNAL_KEYS }));
`,
        { mode: 0o755 },
      );
      const { stdout, stderr } = await run(
        'bash',
        [path.join(sourceRoot, 'scripts/dev-fresh.sh')],
        {
          cwd: os.tmpdir(),
          env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            GEV_PROJECT_ROOT: root,
            TEST_CAPTURE: capture,
            GOOGLE_MAPS_SERVER_API_KEY: 'fixture-exported-server',
          },
          timeout: 30000,
        },
      );
      const result = JSON.parse(await readFile(capture, 'utf8'));
      assert.equal(result.cwd, root);
      assert.deepEqual(result.args, [
        'run',
        'dev',
        '--',
        '--host',
        'localhost',
        '--port',
        '4173',
        '--force',
      ]);
      assert.equal(result.browser, 'fixture-browser');
      assert.equal(result.server, 'fixture-exported-server');
      assert.equal(result.voice, 'fixture-voice');
      assert.equal(result.provenance, 'GOOGLE_MAPS_SERVER_API_KEY');
      assert.doesNotMatch(
        stdout + stderr,
        /fixture-browser|fixture-exported-server|fixture-voice/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

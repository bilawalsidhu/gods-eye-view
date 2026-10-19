import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

test('production microphone worklet is a script file compatible with the document CSP', async () => {
  const result = await build({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    publicDir: false,
    cacheDir: 'node_modules/.vite-local-worklet-test',
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      assetsInlineLimit: 4096,
      rollupOptions: {
        input: fileURLToPath(
          new URL('../voice/localAudioCapture.js', import.meta.url),
        ),
        preserveEntrySignatures: 'strict',
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (bundle) => bundle.output,
  );
  const worklet = outputs.find(
    (entry) =>
      entry.type === 'asset' &&
      /localAudioWorklet-.+\.js$/u.test(entry.fileName),
  );
  assert.ok(
    worklet,
    'A data: worklet is blocked by script-src self; emit a separate script',
  );
  assert.match(String(worklet.source), /registerProcessor\('gev-local-pcm'/u);
  const entry = outputs.find(
    (entry) => entry.type === 'chunk' && entry.isEntry,
  );
  assert.ok(entry.code.includes(worklet.fileName));
  assert.doesNotMatch(entry.code, /data:(?:text|application)\/javascript/u);
});

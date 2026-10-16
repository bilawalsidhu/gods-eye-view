#!/usr/bin/env node
/**
 * qa-scene-dialog-file-drop — the SHARE SCENE dialog's file control accepts a
 * file dropped from the desktop, proved in a real browser.
 *
 * The dialog draws a translated row over the native file input
 * (src/ui/sceneSharing.js, fileChooser). The input must still cover the row,
 * or drops miss it. Drops a file on the row's centre via CDP and expects
 * `input.files` to hold it.
 *
 * Usage:
 *   node scripts/qa-scene-dialog-file-drop.mjs
 *
 * Needs the repository's puppeteer (devDependencies). Exit status 0 when the
 * drop selects the file, 1 otherwise.
 */
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
};

const PAGE = `<!doctype html><html lang="en"><body>
<script type="module">
  import { createSceneDialog } from '/src/ui/sceneSharing.js';
  window.openDialog = () => {
    const dialog = createSceneDialog('Share selected scene', () => {});
    const files = dialog.input('Choose data-pack files', '', { type: 'file' });
    files.multiple = true;
    window.filesInput = files;
    // Centre of the visible row (the wrapper's last child).
    const row = files.parentElement.lastElementChild;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  window.ready = true;
</script></body></html>`;

async function dropOn(client, x, y, file) {
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await client.send('Input.dispatchDragEvent', { type, x, y, data });
  }
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'qa-scene-dialog-drop-'));
  const pack = path.join(dir, 'pack.json');
  await writeFile(pack, '{}');
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    try {
      const body = await readFile(path.join(ROOT, req.url));
      res.writeHead(200, {
        'content-type': TYPES[path.extname(req.url)] || 'text/plain',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 800 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(url);
    await page.waitForFunction(() => window.ready === true);
    const point = await page.evaluate(() => window.openDialog());
    const client = await page.createCDPSession();
    await dropOn(client, point.x, point.y, pack);
    const names = await page.evaluate(() =>
      [...window.filesInput.files].map((file) => file.name),
    );
    console.log(JSON.stringify({ names, errors }));
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    if (names.length !== 1 || names[0] !== 'pack.json') {
      throw new Error(
        `expected the dropped pack.json to be selected, got ${JSON.stringify(names)}`,
      );
    }
    console.log('OK: a file dropped on the visible control is selected');
  } finally {
    await browser.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

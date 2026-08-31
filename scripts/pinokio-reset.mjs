#!/usr/bin/env node
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const target of ['node_modules', 'dist', 'pinokio/.installed']) {
  rmSync(path.join(ROOT, target), { recursive: true, force: true });
}
console.log('[Pinokio] Installation reset. Local credentials were preserved.');

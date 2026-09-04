#!/usr/bin/env node
// Fetch Google Fonts CSS and referenced woff2 files and save locally under public/fonts
// Usage: node scripts/fetch-fonts.mjs

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'public', 'fonts');
await fs.mkdir(outDir, { recursive: true });

// List of Google Fonts CSS URLs used by index.html
const cssUrls = [
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600&display=swap',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0',
  'https://fonts.googleapis.com/icon?family=Material+Icons+Round',
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url} ${res.status}`);
  return await res.text();
}

async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url} ${res.status}`);
  return await res.arrayBuffer();
}

function extractFontUrls(cssText) {
  const urls = [];
  const re = /url\((https?:\\/\\/[^)]+?)\)/g;
  let m;
  while ((m = re.exec(cssText)) !== null) urls.push(m[1].replace(/\\\"|\\\'/g, ''));
  return urls.filter((u) => u.includes('woff2'));
}

async function downloadFonts() {
  for (const cssUrl of cssUrls) {
    try {
      console.log('Fetching CSS:', cssUrl);
      const css = await fetchText(cssUrl);
      const fontUrls = extractFontUrls(css);
      for (const fu of fontUrls) {
        try {
          const urlObj = new URL(fu);
          const filename = path.basename(urlObj.pathname).split('?')[0];
          const outPath = path.join(outDir, filename);
          console.log('Downloading font:', fu, '→', outPath);
          const buf = await fetchArrayBuffer(fu);
          await fs.writeFile(outPath, Buffer.from(buf));
        } catch (e) {
          console.warn('Failed to download font URL', fu, e.message);
        }
      }
      // Save the CSS locally but rewrite referenced URLs to local filenames where possible
      let localCss = css;
      for (const fu of extractFontUrls(css)) {
        const filename = path.basename(new URL(fu).pathname).split('?')[0];
        localCss = localCss.split(fu).join(`./${filename}`);
      }
      const cssName = 'local-fonts.css';
      await fs.writeFile(path.join(outDir, cssName), localCss);
      console.log('Saved local CSS to', path.join(outDir, cssName));
    } catch (e) {
      console.warn('Failed to fetch/parse CSS', cssUrl, e.message);
    }
  }
  console.log('Done. Add <link rel="stylesheet" href="/fonts/local-fonts.css"> to index.html to prefer local fonts.');
}

downloadFonts().catch((err) => { console.error(err); process.exit(1); });

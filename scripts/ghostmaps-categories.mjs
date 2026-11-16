#!/usr/bin/env node
// Show how a GhostMaps KMZ (or plain KML) classifies into map symbols.
//
//   node scripts/ghostmaps-categories.mjs path/to/product.kmz
//
// Prints, for every placemark in the file, the symbol kind the layer would
// draw, the count per kind, the `Type`-style values the popup tables carry,
// and the most common placemark names that fell through to the plain
// `report` symbol: those are the words the keyword rules in
// src/layers/ghostMaps/markers.js do not know yet.
//
// It reads the file with a light regular-expression scan, not a full XML
// parse, so it runs in plain Node. It is a tuning aid, not part of the app.
import { readFileSync } from 'node:fs';
import { readZipEntries, kmzMainDocument } from '../src/data/geoFileImport.js';
import {
  GHOST_MARKER_KINDS,
  descriptionTypeText,
  ghostEventKind,
} from '../src/layers/ghostMaps/markers.js';

const path = process.argv[2];
if (!path) {
  console.error(
    'usage: node scripts/ghostmaps-categories.mjs <file.kmz|file.kml>',
  );
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(path));
let kml;
if (/\.kmz$/i.test(path)) {
  const entries = await readZipEntries(bytes);
  const main = kmzMainDocument(entries);
  if (!main) throw new Error('That KMZ holds no KML document.');
  kml = new TextDecoder().decode(entries.get(main));
} else {
  kml = new TextDecoder().decode(bytes);
}

const unwrap = (text) =>
  String(text ?? '')
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
const tag = (text, name) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(text);
  return match ? unwrap(match[1]) : '';
};

// Folder name per placemark: the nearest enclosing <Folder><name>.
const placemarks = [];
const folderStack = [];
const tokens = kml.split(
  /(<\/?Folder\b[^>]*>|<Placemark\b[\s\S]*?<\/Placemark>)/i,
);
for (const token of tokens) {
  if (/^<Folder\b/i.test(token)) folderStack.push(null);
  else if (/^<\/Folder/i.test(token)) folderStack.pop();
  else if (/^<Placemark\b/i.test(token)) {
    if (!/<Point\b/i.test(token)) continue; // only points get symbols
    const top = folderStack.length - 1;
    placemarks.push({
      folder: folderStack[top] ?? '',
      name: tag(token, 'name'),
      description: tag(token, 'description'),
      iconHref: tag(token, 'href'),
    });
  } else if (folderStack.length && folderStack.at(-1) === null) {
    const name = tag(token, 'name');
    if (name) folderStack[folderStack.length - 1] = name;
  }
}

const byKind = new Map(GHOST_MARKER_KINDS.map((kind) => [kind, 0]));
const typeValues = new Map();
const fallthrough = new Map();
for (const placemark of placemarks) {
  const kind = ghostEventKind(placemark);
  byKind.set(kind, byKind.get(kind) + 1);
  const type = descriptionTypeText(placemark.description);
  if (type) typeValues.set(type, (typeValues.get(type) || 0) + 1);
  if (kind === 'report') {
    const key = placemark.name || '(no name)';
    fallthrough.set(key, (fallthrough.get(key) || 0) + 1);
  }
}
const top = (map, n) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

console.log(`${path}: ${placemarks.length} point placemarks\n`);
console.log('Symbol kinds:');
for (const [kind, count] of byKind)
  console.log(`  ${kind.padEnd(13)} ${count}`);
console.log('\nType-style values in popup tables (top 25):');
for (const [value, count] of top(typeValues, 25))
  console.log(`  ${String(count).padStart(5)}  ${value}`);
if (!typeValues.size) console.log('  (none found)');
console.log('\nNames that fell through to the plain "report" symbol (top 40):');
for (const [name, count] of top(fallthrough, 40))
  console.log(`  ${String(count).padStart(5)}  ${name}`);

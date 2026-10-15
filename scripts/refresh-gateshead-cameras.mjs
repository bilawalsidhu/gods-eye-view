import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://netrafficcams.co.uk';
const a19 = process.argv.includes('--a19');
const all = process.argv.includes('--all');
const listing = `${origin}/all-cameras?field_area_target_id=${a19 || all ? 'All' : '1'}&items_per_page=All&sort_by=title&sort_order=ASC`;
const decode = (text) =>
  text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
async function read(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok)
    throw new Error(`Camera provider returned HTTP ${response.status}`);
  return response.text();
}
const html = await read(listing);
const selectedHtml = a19
  ? [...html.matchAll(/<a href="(\/node\/\d+)" hreflang="en">([^<]+)<\/a>/g)]
      .filter((m) => /\bA19(?!\d)/.test(decode(m[2])))
      .map((m) => `href="${m[1]}"`)
      .join('\n')
  : html;
let nodes = [
  ...new Set(
    [...selectedHtml.matchAll(/href="(\/node\/\d+)"/g)].map((m) => m[1]),
  ),
];
if (all) {
  const existing = await Promise.all(
    ['gateshead', 'a19'].map(async (pack) =>
      JSON.parse(
        await fs.readFile(
          path.join(root, `config/cctv_sources.${pack}.json`),
          'utf8',
        ),
      ),
    ),
  );
  const included = new Set(
    existing.flatMap((pack) =>
      pack.cameras.map((camera) => new URL(camera.sourcePage).pathname),
    ),
  );
  nodes = nodes.filter((node) => !included.has(node));
}
if (!nodes.length || nodes.length > 500)
  throw new Error(
    'Unexpected Gateshead camera listing; preserving the existing catalog.',
  );
const cameras = [];
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < nodes.length) {
      const node = nodes[next++];
      const detail = await read(origin + node);
      const settingsText = detail.match(
        /<script[^>]*data-drupal-selector="drupal-settings-json"[^>]*>([\s\S]*?)<\/script>/,
      )?.[1];
      const point = settingsText
        ? JSON.parse(settingsText)?.openlayers6?.map?.points?.[0]
        : null;
      const image = detail.match(
        /<img[^>]*src="(\/sites\/default\/files\/images\/cameras\/[A-Za-z0-9_.-]+\.jpg)(?:\?[^"<>]*)?"/i,
      )?.[1];
      const title = detail
        .match(/<title>([\s\S]*?)<\/title>/)?.[1]
        ?.split(' | ')[0];
      if (
        !point ||
        !image ||
        !title ||
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon) ||
        point.lat < (all ? 49 : 54.7) ||
        point.lat > (all ? 61 : 55.2) ||
        point.lon < (all ? -9 : -2) ||
        point.lon > (all ? 2 : -1.3)
      ) {
        throw new Error(
          `Missing or invalid published camera metadata: ${node}; preserving the existing catalog.`,
        );
      }
      cameras.push({
        id: `${all ? 'utmc' : a19 ? 'a19' : 'gateshead'}-${node.split('/').pop()}`,
        ...(a19 || all
          ? {
              city:
                /^(Darlington|Durham|Gateshead|Newcastle|North Tyneside|Northumberland|South Tyneside|Stockton-on-Tees|Sunderland|Westmorland & Furness) - /.exec(
                  decode(title),
                )?.[1] || 'Durham',
            }
          : {}),
        name: decode(title).replace(/^Gateshead\s*-\s*/, ''),
        lat: point.lat,
        lon: point.lon,
        url: origin + image,
        sourcePage: origin + node,
      });
    }
  }),
);
cameras.sort((a, b) => a.name.localeCompare(b.name));
const catalog = {
  provider: 'Tyne and Wear UTMC / North East Traffic Cameras',
  listing,
  retrievedAt: new Date().toISOString(),
  note: 'Public snapshots, normally refreshed every 60–300 seconds. The image timestamp is authoritative; images may be old or unavailable. Camera orientations are not supplied.',
  cameras,
};
const output = path.join(
  root,
  `config/cctv_sources.${all ? 'utmc' : a19 ? 'a19' : 'gateshead'}.json`,
);
await fs.writeFile(output + '.tmp', JSON.stringify(catalog, null, 2) + '\n');
await fs.rename(output + '.tmp', output);
console.log(
  `Saved ${cameras.length} ${all ? 'additional UTMC' : a19 ? 'A19' : 'Gateshead'} public camera locations.`,
);

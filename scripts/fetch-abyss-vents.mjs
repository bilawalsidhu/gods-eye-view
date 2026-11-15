import fs from 'node:fs/promises';

async function fetchAndSaveVents() {
  console.log('Fetching NOAA PMEL vents catalog...');
  const res = await fetch('https://www.pmel.noaa.gov/eoi/PlumeStudies/global-vents/global-vents-text.html');
  const html = await res.text();

  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) throw new Error('No table found in NOAA PMEL response');

  const rowMatches = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const vents = [];

  for (let i = 1; i < rowMatches.length; i++) {
    const tr = rowMatches[i][1];
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim(),
    );
    if (cells.length < 8) continue;
    const name = cells[0].replace(/\s+/g, ' ');
    const lon = parseFloat(cells[1]);
    const lat = parseFloat(cells[2]);
    const siteActivity = cells[3];
    const activity = cells[4].toLowerCase();
    const tectonicSetting = cells[5];
    const spreadingRate = cells[6];
    const rawDepth = cells[7];

    if (Number.isNaN(lon) || Number.isNaN(lat)) continue;

    let depthM = null;
    let minDepthM = null;
    let maxDepthM = null;
    if (rawDepth) {
      const parts = rawDepth
        .split('-')
        .map((p) => parseFloat(p.trim()))
        .filter((n) => !Number.isNaN(n));
      if (parts.length === 1) {
        depthM = parts[0];
        minDepthM = parts[0];
        maxDepthM = parts[0];
      } else if (parts.length >= 2) {
        minDepthM = Math.min(parts[0], parts[1]);
        maxDepthM = Math.max(parts[0], parts[1]);
        depthM = maxDepthM;
      }
    }

    vents.push({
      id: `vent-${i}`,
      name,
      lon,
      lat,
      siteActivity,
      activity: ['active', 'inactive', 'unconfirmed'].includes(activity) ? activity : 'unconfirmed',
      tectonicSetting: tectonicSetting || 'other',
      spreadingRate: spreadingRate || 'unknown',
      depthM,
      minDepthM,
      maxDepthM,
      source: 'NOAA PMEL Earth-Ocean Interactions',
      sourceUrl: 'https://www.pmel.noaa.gov/eoi/PlumeStudies/global-vents/global-vents-text.html',
    });
  }

  await fs.writeFile('src/layers/abyss/vents.json', JSON.stringify(vents, null, 2), 'utf8');
  console.log(`Saved ${vents.length} vents to src/layers/abyss/vents.json`);
}

fetchAndSaveVents().catch((err) => {
  console.error(err);
  process.exit(1);
});

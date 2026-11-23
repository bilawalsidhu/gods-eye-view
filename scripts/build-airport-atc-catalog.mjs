import { readFile, writeFile } from 'node:fs/promises';
import { parseCsvRows } from '../src/library/formats.js';
import { parseAtcChannel } from '../src/sdr/atcChannels.js';

const [airportsFile, frequenciesFile] = process.argv.slice(2);
if (!airportsFile || !frequenciesFile) {
  throw new Error(
    'Usage: node scripts/build-airport-atc-catalog.mjs airports.csv airport-frequencies.csv',
  );
}

async function records(file) {
  const [header, ...rows] = parseCsvRows(await readFile(file, 'utf8'));
  return rows.map((row) =>
    Object.fromEntries(header.map((key, index) => [key, row[index]])),
  );
}

const byAirport = new Map();
for (const row of await records(frequenciesFile)) {
  if (row.type !== 'TWR' && row.type !== 'APP') continue;
  const channel = parseAtcChannel(row.frequency_mhz);
  if (!channel) continue;
  if (!byAirport.has(row.airport_ref)) byAirport.set(row.airport_ref, []);
  byAirport.get(row.airport_ref).push([row.type, channel.label]);
}

const catalog = [];
for (const airport of await records(airportsFile)) {
  const channels = byAirport.get(airport.id);
  if (!channels || airport.type === 'closed') continue;
  const lat = Number.parseFloat(airport.latitude_deg);
  const lon = Number.parseFloat(airport.longitude_deg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const unique = new Map(channels.map((entry) => [entry.join(':'), entry]));
  catalog.push({
    ident: airport.ident,
    code: airport.icao_code || airport.ident,
    iata: airport.iata_code || null,
    lat: Number(lat.toFixed(4)),
    lon: Number(lon.toFixed(4)),
    channels: [...unique.values()].sort(),
  });
}
catalog.sort((a, b) => a.ident.localeCompare(b.ident, 'en'));
const destination = new URL(
  '../src/data/airportAtcCatalog.json',
  import.meta.url,
);
await writeFile(
  destination,
  `[\n${catalog.map((airport) => JSON.stringify(airport)).join(',\n')}\n]\n`,
);
console.log(`Wrote ${catalog.length} airports with VHF ATC channels`);

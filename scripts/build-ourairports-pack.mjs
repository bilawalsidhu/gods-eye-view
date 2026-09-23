/**
 * @file scripts/build-ourairports-pack.mjs
 * @description Fetches and compiles OurAirports global airport frequencies into a
 * compact, production-ready dataset for gods-eye-view ATC radio.
 *
 * Source: OurAirports (Public Domain / CC0)
 * Data URLs:
 *   https://davidmegginson.github.io/ourairports-data/airports.csv
 *   https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'src', 'data', 'local_data', 'ourairports');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'atc_airports.json');
const README_FILE = path.join(OUTPUT_DIR, 'README.md');

const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const FREQUENCIES_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv';

/**
 * Basic RFC 4180 CSV line parser handling quotes.
 */
function parseCsv(content) {
  const lines = content.split(/\r?\n/);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    if (values.length !== header.length) continue;
    const obj = {};
    for (let h = 0; h < header.length; h++) {
      obj[header[h]] = values[h];
    }
    rows.push(obj);
  }
  return rows;
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur);
  return result;
}

function formatFreq(freqNum) {
  const num = Number(freqNum);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(3);
}

async function run() {
  console.log('Fetching OurAirports frequencies and airports data...');
  const [airportsRes, freqsRes] = await Promise.all([
    fetch(AIRPORTS_CSV_URL),
    fetch(FREQUENCIES_CSV_URL),
  ]);

  if (!airportsRes.ok || !freqsRes.ok) {
    throw new Error(`Failed to fetch OurAirports data: airports=${airportsRes.status}, freqs=${freqsRes.status}`);
  }

  const [airportsCsv, freqsCsv] = await Promise.all([
    airportsRes.text(),
    freqsRes.text(),
  ]);

  console.log('Parsing CSV data...');
  const airportRows = parseCsv(airportsCsv);
  const freqRows = parseCsv(freqsCsv);

  console.log(`Loaded ${airportRows.length} airports, ${freqRows.length} frequencies.`);

  // Group frequencies by airport_ident
  // Frequency types mapped:
  // tower: TWR, TOWER, CTAF
  // approach: APP, APPROACH, ARR, DEP, RADAR, DIR
  // atis: ATIS, AWOS, ASOS
  // ground: GND, GROUND, RAMP, APRON, TAXI
  const freqsByAirport = new Map();

  for (const f of freqRows) {
    const ident = (f.airport_ident || '').trim().toUpperCase();
    if (!ident) continue;
    const freqMhz = Number(f.frequency_mhz);
    // VHF voice comm band: 118.0 - 137.0 MHz (with some ATIS/NAVAID extending to 108.0 MHz)
    if (!Number.isFinite(freqMhz) || freqMhz < 108 || freqMhz > 137) continue;

    const rawType = (f.type || '').trim().toUpperCase();
    const desc = (f.description || '').trim().toUpperCase();

    let targetType = null;
    if (rawType.includes('TWR') || rawType === 'TOWER' || desc.includes('TWR') || desc.includes('TOWER')) {
      targetType = 'tower';
    } else if (rawType.includes('APP') || rawType.includes('DEP') || rawType.includes('ARR') || desc.includes('APP') || desc.includes('APPROACH')) {
      targetType = 'approach';
    } else if (rawType.includes('ATIS') || rawType.includes('AWOS') || rawType.includes('ASOS') || desc.includes('ATIS')) {
      targetType = 'atis';
    } else if (rawType.includes('GND') || rawType.includes('GROUND') || rawType.includes('RAMP') || desc.includes('GROUND')) {
      targetType = 'ground';
    } else if (rawType === 'CTAF' || rawType === 'UNIC') {
      targetType = 'ctaf'; // fallback tower if no primary tower
    }

    if (!targetType) continue;

    if (!freqsByAirport.has(ident)) {
      freqsByAirport.set(ident, {});
    }
    const bucket = freqsByAirport.get(ident);
    if (!bucket[targetType]) {
      bucket[targetType] = formatFreq(freqMhz);
    }
  }

  // Create airport records
  const resultAirports = [];

  for (const apt of airportRows) {
    const ident = (apt.ident || '').trim().toUpperCase();
    const icao = (apt.icao_code || (ident.length === 4 ? ident : '')).trim().toUpperCase();
    if (!icao) continue;

    const freqs = freqsByAirport.get(ident) || (icao !== ident ? freqsByAirport.get(icao) : null);
    if (!freqs) continue;

    // Build normalized frequencies object
    const finalFreqs = {};
    if (freqs.tower) finalFreqs.tower = freqs.tower;
    else if (freqs.ctaf) finalFreqs.tower = freqs.ctaf;
    else if (freqs.approach) finalFreqs.tower = freqs.approach;
    else if (freqs.ground) finalFreqs.tower = freqs.ground;
    else if (freqs.atis) finalFreqs.tower = freqs.atis;

    if (freqs.approach) finalFreqs.approach = freqs.approach;
    if (freqs.atis) finalFreqs.atis = freqs.atis;
    if (freqs.ground) finalFreqs.ground = freqs.ground;

    // Must have at least one useful VHF frequency
    if (Object.keys(finalFreqs).length === 0) continue;

    const lat = Number(apt.latitude_deg);
    const lon = Number(apt.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const elevationFt = Number(apt.elevation_ft);
    const elevationM = Number.isFinite(elevationFt) ? Math.round(elevationFt * 0.3048) : 0;

    resultAirports.push({
      icao,
      iata: (apt.iata_code || '').trim().toUpperCase() || undefined,
      name: (apt.name || '').trim(),
      city: (apt.municipality || '').trim() || undefined,
      country: (apt.iso_country || '').trim().toUpperCase() || undefined,
      lat: Number(lat.toFixed(4)),
      lon: Number(lon.toFixed(4)),
      elevationM,
      frequencies: finalFreqs,
    });
  }

  // Sort by ICAO code
  resultAirports.sort((a, b) => a.icao.localeCompare(b.icao));

  // Deduplicate by ICAO if any
  const uniqueAirports = [];
  const seenIcao = new Set();
  for (const apt of resultAirports) {
    if (!seenIcao.has(apt.icao)) {
      seenIcao.add(apt.icao);
      uniqueAirports.push(apt);
    }
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const jsonStr = JSON.stringify(uniqueAirports);
  fs.writeFileSync(OUTPUT_FILE, jsonStr, 'utf-8');

  const stats = fs.statSync(OUTPUT_FILE);
  console.log(`Generated ${uniqueAirports.length} airports with VHF frequencies.`);
  console.log(`Output file size: ${(stats.size / 1024).toFixed(1)} KB (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  const readmeContent = `# OurAirports Global ATC Airport Frequencies

Public domain airport VHF frequency registry bundled for the Air Traffic Control (ATC) radio auto-tuner.

- Source: [OurAirports](https://ourairports.com) by David Megginson & contributors
- Data snapshot: \`airports.csv\` & \`airport-frequencies.csv\`
- License: Public Domain / Creative Commons CC0 1.0 Universal (CC0 1.0)
- Airport count: ${uniqueAirports.length}
- Runtime file: \`atc_airports.json\`
- Frequencies included: Tower (TWR/CTAF), Approach (APP/DEP/ARR), ATIS (ATIS/AWOS/ASOS), and Ground (GND/RAMP) within civil VHF aviation band (108.0 - 137.0 MHz).
`;

  fs.writeFileSync(README_FILE, readmeContent, 'utf-8');
  console.log('Wrote README.md');
}

run().catch((err) => {
  console.error('Build error:', err);
  process.exit(1);
});

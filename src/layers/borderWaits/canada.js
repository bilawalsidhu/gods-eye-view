// Waits into Canada from the Canada Border Services Agency (CBSA), joined to
// the CBP crossing each CBSA office faces. Pure — no Cesium, DOM or Node.

// CBSA "Customs Office" → CBP `port_number`. CBSA reports the busiest
// offices only; offices with no CBP crossing on the other side (Lacolle
// Routes 221 and 223, Hemmingford, North Portal) are reported as unmatched.
export const CBSA_OFFICE_CROSSINGS = Object.freeze({
  'St. Stephen': '011501',
  'St. Stephen 3rd Bridge': '011503',
  Edmundston: 'L01901',
  'Woodstock Road': '010601',
  Stanstead: '020901',
  'St-Armand/Philipsburg': '021201',
  'St-Bernard-de-Lacolle': '071201',
  'Cornwall Traffic Office': '070401',
  Prescott: '070101',
  'Thousand Islands Bridge': '070801',
  'Sault Ste. Marie': '380301',
  'Fort Frances Bridge': '360401',
  'Queenston-Lewiston Bridge': '090104',
  'Rainbow Bridge': '090102',
  'Peace Bridge': '090101',
  'Blue Water Bridge': '380201',
  'Windsor and Detroit Tunnel': '380002',
  'Ambassador Bridge': '380001',
  'Gordie Howe International Bridge': '380102',
  Emerson: '340101',
  Coutts: '331001',
  'Abbotsford-Huntingdon': '300901',
  Aldergrove: '302301',
  'Pacific Highway': '300401',
  Douglas: '300402',
  'Boundary Bay': '300403',
});

const COLUMNS = Object.freeze({
  office: 'Customs Office',
  updated: 'Last updated',
  commercial: 'Commercial Flow - Canada bound',
  travellers: 'Travellers Flow - Canada bound',
});

/**
 * One CBSA flow value: "No Delay", "5 minutes", "Closed", or not reported
 * ("Not Applicable", "--", blank, anything else).
 * @returns {{status: string, delayMinutes: number|null}|null}
 */
export function parseCbsaFlow(value) {
  const text = String(value ?? '').trim();
  if (/^no delay$/i.test(text)) return { status: 'no delay', delayMinutes: 0 };
  if (/^closed$/i.test(text)) return { status: 'closed', delayMinutes: null };
  const minutes = text.match(/^(\d{1,4}) minutes?$/i);
  if (minutes) {
    const delayMinutes = Number(minutes[1]);
    return delayMinutes <= 1440 ? { status: 'delay', delayMinutes } : null;
  }
  return null;
}

/**
 * Parse CBSA's current land-border CSV (`;;`-separated, with a BOM) into
 * Canada-bound waits keyed by CBP crossing id. Returns null when the header
 * is not CBSA's, so a changed format can never pass as "no waits".
 * @param {string} csv - https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv
 * @returns {{byCrossing: Record<string, Object>, unmatched: string[]}|null}
 */
export function parseCbsaCsv(csv) {
  if (typeof csv !== 'string') return null;
  const lines = csv
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length || lines.length > 500) return null;
  const split = (line) => line.split(';;').map((cell) => cell.trim());
  const header = split(lines[0]);
  const index = {};
  for (const [key, name] of Object.entries(COLUMNS)) {
    index[key] = header.indexOf(name);
    if (index[key] < 0) return null;
  }
  const byCrossing = {};
  const unmatched = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const office = cells[index.office];
    if (!office || office.length > 80 || /[<>]/.test(office)) continue;
    const id = Object.hasOwn(CBSA_OFFICE_CROSSINGS, office)
      ? CBSA_OFFICE_CROSSINGS[office]
      : null;
    if (!id) {
      unmatched.push(office);
      continue;
    }
    const updated = cells[index.updated];
    byCrossing[id] = {
      office,
      travellers: parseCbsaFlow(cells[index.travellers]),
      commercial: parseCbsaFlow(cells[index.commercial]),
      updated:
        updated && updated.length <= 40 && !/[<>]/.test(updated)
          ? updated
          : null,
    };
  }
  return { byCrossing, unmatched };
}

/** Attach each crossing's Canada-bound waits (or null) to normalized rows. */
export function attachCanadaBound(rows, byCrossing = {}) {
  return rows.map((row) => ({
    ...row,
    canada: Object.hasOwn(byCrossing, row.id) ? byCrossing[row.id] : null,
  }));
}

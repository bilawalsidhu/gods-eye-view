#!/usr/bin/env node
/**
 * Scaffold a Historic Fires event from NIFC Open Data.
 *
 *   node scripts/fire-event-scaffold.mjs --name Dixie --year 2021 [--state US-CA]
 *       [--service wfigs|nifc-history] [--pick N] [--id dixie-fire-2021]
 *       [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--bbox W,S,E,N]
 *       [--region "..."] [--summary "..."] [--ref "Label=https://..."]... [--write]
 *
 * Looks the incident up (WFIGS for 2020+, the interagency perimeter history
 * before), lists the candidates, picks the largest (or --pick), reads its
 * extent for the bbox, derives the day window from the published dates and
 * prints a config/fire_events.json entry that already passes the proxy's
 * validation. --write appends it to the config. Everything it cannot take
 * from the record is flagged as a warning — fill those in before committing.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { projectRoot } from './project-root.mjs';
import {
  buildEventEntry,
  candidateQueryUrl,
  deriveWindow,
  extentQueryUrl,
  formatCandidateTable,
  padBbox,
  rankCandidates,
} from '../src/data/fireEventScaffold.js';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    year: { type: 'string' },
    state: { type: 'string' },
    service: { type: 'string' },
    pick: { type: 'string' },
    id: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    bbox: { type: 'string' },
    region: { type: 'string' },
    summary: { type: 'string' },
    ref: { type: 'string', multiple: true, default: [] },
    write: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (args.help || !args.name || !/^\d{4}$/.test(args.year || '')) {
  console.log(
    'usage: node scripts/fire-event-scaffold.mjs --name <incident> --year <YYYY> [--state US-XX] [--service wfigs|nifc-history] [--pick N] [--id ..] [--start ..] [--end ..] [--bbox W,S,E,N] [--region ..] [--summary ..] [--ref "Label=https://.."] [--write]',
  );
  process.exit(args.help ? 0 : 2);
}
const year = Number(args.year);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`NIFC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`NIFC: ${body.error.message || 'query error'}`);
  return body;
}

const { service, url } = candidateQueryUrl({
  name: args.name,
  year,
  state: args.state,
  service: args.service,
});
console.error(`Searching ${service} for "${args.name}" in ${year}…`);
const candidates = rankCandidates(await getJson(url), service);
if (!candidates.length) {
  console.error(
    `No ${service} record matched. Try the other service (--service ${service === 'wfigs' ? 'nifc-history' : 'wfigs'}), a different spelling, or drop --state.`,
  );
  process.exit(1);
}
console.error(formatCandidateTable(candidates));
const pick = args.pick === undefined ? 0 : Number(args.pick);
const candidate = candidates[pick];
if (!candidate) {
  console.error(`--pick ${args.pick} is out of range`);
  process.exit(1);
}
console.error(`Using [${pick}] ${candidate.name} (OBJECTID ${candidate.objectId})`);

let bbox;
if (args.bbox) {
  bbox = args.bbox.split(',').map(Number);
} else {
  const { extent } = await getJson(extentQueryUrl(service, candidate.objectId));
  bbox = padBbox(extent);
}
const window = deriveWindow(candidate, { start: args.start, end: args.end });
const references = args.ref.map((pair) => {
  const at = pair.indexOf('=');
  if (at < 1) throw new Error(`--ref expects "Label=https://url", got "${pair}"`);
  return { label: pair.slice(0, at).trim(), url: pair.slice(at + 1).trim() };
});
const { entry, warnings } = buildEventEntry({
  candidate,
  service,
  year,
  bbox,
  id: args.id,
  region: args.region,
  summary: args.summary,
  references,
  window,
});

console.log(JSON.stringify(entry, null, 2));
for (const warning of warnings) console.error(`warning: ${warning}`);

if (args.write) {
  const configPath = path.join(projectRoot(import.meta.url), 'config', 'fire_events.json');
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  if (config.events.some((e) => e.id === entry.id)) {
    console.error(`config already has an event with id "${entry.id}" — pass --id to rename`);
    process.exit(1);
  }
  config.events.push(entry);
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.error(`Appended ${entry.id} to config/fire_events.json — the dev server restarts and picks it up.`);
}

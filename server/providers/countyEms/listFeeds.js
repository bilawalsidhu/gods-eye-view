import { createHash } from 'node:crypto';
import { easternTime } from '../chesterCountyEms/parser.js';
import {
  createCachedCountyFeed,
  readPublicText,
  publicText,
} from './publicFeed.js';

export const DAUPHIN_PAGE = 'https://dpswebcad.dauphincounty.gov/webcad/';
export const PIKE_PAGE =
  'https://webcad.pikepa.org/pages/public/FeedReader.asp';
export const YORK_PAGE = 'https://ycdes.org/webcad/default.aspx';
export const cells = (html) =>
  [...html.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
export const records = (html) =>
  [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => cells(m[1]));
export const digest = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);
const bounded = (value) => {
  const text = publicText(value);
  if (text.length > 500) throw new Error('Oversized public summary');
  return text;
};
const rowBase = (countyId, category, key, detailUrl) => ({
  id: countyId + ':' + category + ':' + key,
  countyId,
  category,
  incidentNumber: null,
  station: '',
  detailUrl,
  mapPosition: null,
  locationStatus: 'not-published',
  assignedUnits: [],
});
export const easternDate = (time) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(time);
export const minuteTime = (text) =>
  easternTime(text.replace(/(\d:\d{2})(\s*[AP]M)$/i, '$1:00$2'));
const ensureRows = (rows) => {
  if (rows.length > 500 || new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error('Invalid public report identities');
  return rows;
};

/** Official active tables have no incident IDs, map coordinates or unit lists. */
export function parseDauphinList(html, now = Date.now()) {
  if (
    !/Active Fire Events/.test(html) ||
    !/Active Medical Events/.test(html) ||
    !/Active Traffic Events/.test(html)
  )
    throw new Error('Invalid Dauphin list');
  const rows = [],
    sections = new Set();
  for (const section of html.matchAll(
    /<h2\b[^>]*>\s*(Active Fire Events|Active Medical Events|Active Traffic Events|Controlled Burns)\s*<\/h2>\s*<table\b[^>]*>([\s\S]*?)<\/table>/gi,
  )) {
    if (sections.has(section[1])) throw new Error('Duplicate Dauphin section');
    sections.add(section[1]);
    const category = /Medical/.test(section[1])
      ? 'ems'
      : /Traffic/.test(section[1])
        ? 'traffic'
        : 'fire';
    const items = records(section[2]);
    const header = items.shift()?.map(publicText);
    const expected = [
      'DATE/TIME',
      'MUNICIPALITY',
      'STREET',
      'CROSS STREETS',
      'EVENT TYPE',
    ];
    if (
      !header ||
      expected.some((label, i) => header[i] !== label) ||
      header.length > 6 ||
      (header.length === 6 && header[5] !== 'EVENT SUB TYPE')
    )
      throw new Error('Unknown Dauphin table');
    for (const values of items) {
      const v = values.map(bounded);
      if (v.length === 1 && /no (?:active )?(?:events|incidents)/i.test(v[0]))
        continue;
      if (v.length !== header.length) throw new Error('Invalid Dauphin row');
      const reportedAt = easternTime(v[0]);
      const type = [v[4], v[5]].filter(Boolean).join(' / ');
      rows.push({
        ...rowBase(
          'dauphin-pa',
          category,
          digest([category, ...v].join('|')),
          DAUPHIN_PAGE,
        ),
        type,
        location: v[2],
        municipality: v[1],
        crossStreets: v[3],
        dispatched: v[0],
        dispatchedAt: null,
        reportedAt,
        timeBasis: 'reported',
        ...(section[1] === 'Controlled Burns' ? { controlledBurn: true } : {}),
      });
    }
  }
  if (
    ![
      'Active Fire Events',
      'Active Medical Events',
      'Active Traffic Events',
    ].every((heading) => sections.has(heading))
  )
    throw new Error('Missing Dauphin table');
  return {
    rows: ensureRows(rows),
    observedAt: now,
    timestampBasis: 'retrieved',
  };
}

/** Read only today's public completed press feed, never protected Pike WebCAD. */
export function parsePikeList(html, now = Date.now()) {
  if (
    !/Completed Incidents/i.test(publicText(html)) ||
    !/Pike County/i.test(publicText(html))
  )
    throw new Error('Invalid Pike press feed');
  let section = null;
  const rows = [],
    sections = new Set();
  for (const values of records(html)) {
    const v = values.map(bounded);
    if (v.length === 1) {
      if (v[0] === 'Fire Incidents') section = 'fire';
      else if (v[0] === 'Medical Incidents') section = 'ems';
      else if (/Road Closures.*Controlled Burns/i.test(v[0])) section = 'mixed';
      if (
        ['Fire Incidents', 'Medical Incidents'].includes(v[0]) ||
        /Road Closures.*Controlled Burns/i.test(v[0])
      )
        sections.add(section);
      continue;
    }
    if (!/^\d/.test(v[0])) continue;
    if (v.length !== 4) throw new Error('Invalid Pike table');
    if (!section) throw new Error('Unknown Pike category');
    const identity = v[0].match(
      /^(\d{6,16})\s+(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2})$/,
    );
    if (!identity) throw new Error('Invalid Pike clock');
    const receivedAt = easternTime(identity[2]);
    if (easternDate(receivedAt) !== easternDate(now)) continue;
    const category =
      section === 'mixed'
        ? /ROAD CLOSURE/i.test(v[1])
          ? 'traffic'
          : /CONTROLLED BURN/i.test(v[1])
            ? 'fire'
            : null
        : section;
    if (!category) continue;
    const places = values[2]
      .split(/<br\s*\/?>/i)
      .map(bounded)
      .filter(Boolean);
    rows.push({
      ...rowBase('pike-pa', category, identity[1], PIKE_PAGE),
      incidentNumber: identity[1],
      type: v[1],
      location: places[0] || '',
      municipality: places[1] || '',
      dispatched: identity[2],
      dispatchedAt: null,
      receivedAt,
      timeBasis: 'received',
      reportKind: 'completed',
      official: true,
      assignedUnits: values[3]
        .split(/<br\s*\/?>/i)
        .map(bounded)
        .filter(Boolean),
    });
  }
  if (sections.size !== 3) throw new Error('Missing Pike category table');
  if (
    rows.some(
      (row) =>
        row.assignedUnits.length > 128 ||
        row.assignedUnits.some((unit) => unit.length > 200),
    )
  )
    throw new Error('Oversized Pike units');
  return {
    rows: ensureRows(rows),
    observedAt: now,
    timestampBasis: 'retrieved',
    coverageKind: 'completed-reports',
    limited: true,
  };
}

/** Source labels remain distinct: nearest intersection is not an exact scene. */
export function parseYorkList(html) {
  const clock = publicText(html).match(
    /Data as of:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M)/i,
  );
  const table = html.match(
    /<h2\b[^>]*>\s*Active Incidents\s*<\/h2>\s*<table\b[^>]*>([\s\S]*?)<\/table>/i,
  );
  if (!clock || !table) throw new Error('Invalid York list');
  const rows = [],
    items = records(table[1]);
  if (
    items.length &&
    items[0].length === 1 &&
    /no active incidents/i.test(publicText(items[0][0]))
  )
    return { rows, observedAt: easternTime(clock[1]) };
  if (
    JSON.stringify(items.shift()?.map(publicText)) !==
    JSON.stringify([
      'Incident Type',
      'Dispatch Time',
      'Box No.',
      'Incident Type',
      'Street',
      'Cross Street',
      'Nearest Intersection',
      'Location',
      '',
    ])
  )
    throw new Error('Unknown York table');
  for (const values of items) {
    const v = values.map(bounded);
    if (v.length !== 9) throw new Error('Invalid York row');
    const category = {
      FIRE: 'fire',
      EMS: 'ems',
      MEDICAL: 'ems',
      TRAFFIC: 'traffic',
    }[v[0]];
    if (!category) throw new Error('Unknown York category');
    const href = values[8].match(
      /href=["']?(Details\.aspx\?[A-Za-z0-9+/=%]+)(?:["'\s>])/i,
    )?.[1];
    if (!href || href.length > 240) throw new Error('Invalid York detail link');
    const dispatchedAt = minuteTime(v[1]);
    rows.push({
      ...rowBase(
        'york-pa',
        category,
        digest([category, dispatchedAt, v[2], v[4], v[7]].join('|')),
        new URL(href, YORK_PAGE).href,
      ),
      type: v[3],
      location: v[4],
      municipality: v[7],
      crossStreets: v[5],
      nearestIntersection: v[6],
      box: v[2],
      dispatched: v[1],
      dispatchedAt,
      timePrecision: 'minute',
    });
  }
  return { rows: ensureRows(rows), observedAt: easternTime(clock[1]) };
}

/** York publishes assigned unit names/descriptions, without movement clocks. */
export function createYorkDetails({
  getSnapshot,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const cache = new Map();
  return async (id) => {
    const snapshot = await getSnapshot(),
      row = snapshot.rows.find((r) => r.id === id);
    if (!row)
      throw Object.assign(new Error('Incident is no longer listed'), {
        statusCode: 404,
      });
    for (const key of cache.keys())
      if (!snapshot.rows.some((r) => r.id === key)) cache.delete(key);
    const previous = cache.get(id);
    if (previous && now() - previous.fetchedAt < 60000) return previous;
    const html = await readPublicText(fetchImpl, row.detailUrl);
    if (!/Incident Details/.test(html)) throw new Error('Invalid York details');
    const table = html.match(
      /<table\b[^>]*class="incidentList"[^>]*>([\s\S]*?)<\/table>/i,
    );
    const units = [];
    if (table) {
      const items = records(table[1]);
      if (
        JSON.stringify(items.shift()?.map(publicText)) !==
        JSON.stringify(['Unit Number', 'Description'])
      )
        throw new Error('Unknown York units');
      for (const cells of items) {
        if (cells.length !== 2 || units.length >= 128)
          throw new Error('Invalid York units');
        units.push({
          unit: bounded(cells[0]),
          status: 'Assigned',
          description: bounded(cells[1]),
          entered: '',
          enteredAt: null,
        });
      }
    } else if (!/no (?:assigned )?units/i.test(publicText(html)))
      throw new Error('Missing York units');
    const detail = {
      id,
      incidentNumber: null,
      observedAt: now(),
      fetchedAt: now(),
      timestampBasis: 'retrieved',
      assignmentOnly: true,
      stale: !!snapshot.stale,
      sourceUrl: row.detailUrl,
      units,
    };
    cache.set(id, detail);
    return detail;
  };
}

/** Bounded readers use each site's own refresh cadence and independent caches. */
export const createDauphinCountyFeed = ({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) =>
  createCachedCountyFeed({
    now,
    ttl: 240000,
    unavailable: 'Dauphin incidents unavailable',
    load: async () =>
      parseDauphinList(await readPublicText(fetchImpl, DAUPHIN_PAGE), now()),
  });
export const createPikeCountyFeed = ({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) =>
  createCachedCountyFeed({
    now,
    ttl: 240000,
    unavailable: 'Pike reports unavailable',
    load: async () => {
      const url = new URL(PIKE_PAGE);
      url.searchParams.set('ddlOriginationDate', easternDate(now()));
      url.searchParams.set('ddlGroupingTitle', '');
      return parsePikeList(await readPublicText(fetchImpl, url.href), now());
    },
  });
export const createYorkCountyFeed = ({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) =>
  createCachedCountyFeed({
    now,
    ttl: 240000,
    unavailable: 'York incidents unavailable',
    load: async () => parseYorkList(await readPublicText(fetchImpl, YORK_PAGE)),
  });

import { greatCircleKm } from '../../geoDistance.js';

/**
 * @module rail/dedupe
 * @description One physical train drawn once when several loaded feeds carry
 * it (an operator's own feed and a national feed that lists its trains too,
 * a cross-border train reported on both sides).
 *
 * Matching, between copies from different feeds:
 *  - both carry a train number: the same normalised number (its last digit
 *    group without leading zeros: `RJX 160`, `160`), up to NUMBER_RADIUS_KM
 *    apart. Numbers that differ are different trains. A name's number is a
 *    train's when it has three digits or more, or follows a long-distance
 *    product (`EC 7`, `NJ 40`); a trip id that is an operator prefix and a
 *    number (`AM:530`) and a bare-number headsign (where a feed with no
 *    trip names writes the train number) are read too.
 *  - a shorter number after anything else names a line (`S1`, `RB 1`,
 *    `U6`), which many trains run: copies on different lines are different
 *    trains, and copies on one line within MATCH_RADIUS_KM are one train
 *    only in the same category, the nearest pairs first.
 * A train has at most one copy per feed; the strongest matches join first.
 *
 * Choosing the copy drawn:
 *  1. position source: live GPS, then station reports;
 *  2. the line: a copy bound to its operator's shape (a built pack), then
 *     one without.
 * The copy drawn stays drawn until another scores strictly higher, so equal
 * copies never trade places. A copy a first-person view holds
 * (cockpitSubject.js) stays drawn whatever the scores until the view lets
 * go: the view knows the train by that copy's key and rides it where that
 * copy's feed puts it, tens of kilometres from another feed's copy at
 * times. A losing copy keeps its playback and is only hidden; when a feed
 * leaves the viewport its copies' partners come back. The comparison runs
 * once per poll, never per frame.
 */

/**
 * Copies farther apart than this are different trains (km): two copies of
 * one train at one moment differ only by where each feed reports it.
 */
export const MATCH_RADIUS_KM = 15;
/**
 * Copies with the same number match up to this far apart (km): two feeds
 * report one train at different moments, and one polled every few minutes
 * can be tens of kilometres behind at speed.
 */
export const NUMBER_RADIUS_KM = 100;
/**
 * Grid cell for finding nearby copies (degrees). A row (27.8 km) spans
 * MATCH_RADIUS_KM; a column narrows away from the equator (13.9 km at
 * 60°N), so as many columns either side are searched as reach it
 * (columnSpan).
 */
const CELL_DEG = 0.25;

const POSITION_RANK = Object.freeze({
  gps: 2,
  event: 1,
});
/**
 * Products whose trains carry short numbers of their own (`EC 7`, `NJ 40`).
 * Not `IC`: in Switzerland `IC 1` and `IC 5` are lines run by many trains a
 * day, and IC train numbers elsewhere have three or more digits anyway.
 */
const LONG_DISTANCE_PRODUCTS = new Set([
  'EC',
  'ECE',
  'EN',
  'ICE',
  'NJ',
  'RJ',
  'RJX',
  'TGV',
]);

/**
 * A train number comparable across feeds: the last group of digits, without
 * leading zeros (`RJX 160` → `160`, `09725` → `9725`), or null.
 * @param {string|null|undefined} label
 * @returns {string|null}
 */
export function trainNumber(label) {
  const digits = /(\d{1,6})\D*$/.exec(String(label ?? ''))?.[1];
  const number = digits?.replace(/^0+/, '') ?? '';
  return number || null;
}

/**
 * What a name's number says: a train's own number (three digits or more,
 * or after a long-distance product: `RJX 160`, `EC 7`), or a line's
 * (`S1`, `RB 1`, `U6`: each run by many trains), with its product.
 * @param {string|null|undefined} label
 * @returns {{number: string|null, line: {product: string,
 *   number: string}|null}}
 */
export function labelNumbers(label) {
  const match = /([A-Za-z]*)\s*(\d{1,6})\D*$/.exec(String(label ?? ''));
  const number = match?.[2].replace(/^0+/, '') ?? '';
  if (!number) return { number: null, line: null };
  const product = match[1].toUpperCase();
  return number.length >= 3 || LONG_DISTANCE_PRODUCTS.has(product)
    ? { number, line: null }
    : { number: null, line: { product, number } };
}

/**
 * A record's train number and line: the number from its name, unless that
 * is only the vehicle's own id (a feed that labels each train with its car
 * number) or names a line; else from a trip id that is an operator
 * prefix and a number (`AM:530`); else from a headsign that is a bare
 * number (where a feed with no trip names writes the train number). The line is the name's,
 * when it names one.
 * @param {{id?: string|null, label?: string|null, tripId?: string|null,
 *   headsign?: string|null}} record
 * @returns {{number: string|null, line: {product: string,
 *   number: string}|null}}
 */
export function recordNumbers(record) {
  const label = String(record?.label ?? '').trim();
  const named =
    label && label !== String(record?.id ?? '')
      ? labelNumbers(label)
      : { number: null, line: null };
  if (named.number) return named;
  const trip = /^[A-Za-z]{1,6}:(\d{1,6})$/.exec(
    String(record?.tripId ?? '').trim(),
  );
  const headsign = String(record?.headsign ?? '').trim();
  const number = trip
    ? trainNumber(trip[1])
    : /^\d{3,6}$/.test(headsign)
      ? trainNumber(headsign)
      : null;
  return number ? { number, line: null } : named;
}

/**
 * A record's train number (recordNumbers), or null.
 * @param {object} record
 * @returns {string|null}
 */
export function recordTrainNumber(record) {
  return recordNumbers(record).number;
}

/** Whether two lines can be one: one number, and one product where both name it. */
function sameLine(a, b) {
  return (
    a.number === b.number &&
    (!a.product || !b.product || a.product === b.product)
  );
}

/** A number match outranks any line match. */
const NUMBER_MATCH = 2;

/**
 * How strongly two copies are the same physical train: 0 when they are not,
 * NUMBER_MATCH for the same number, else, for one line in one category,
 * between 0.5 and 1, higher the nearer they are. See the module notes.
 * @param {object} a A copy (`copyOf` in createDuplicateFilter).
 * @param {object} b
 * @returns {number}
 */
export function matchStrength(a, b) {
  if (a.feedId === b.feedId) return 0;
  const km = greatCircleKm(a, b);
  if (a.number && b.number)
    return km <= NUMBER_RADIUS_KM && a.number === b.number ? NUMBER_MATCH : 0;
  if (km > MATCH_RADIUS_KM) return 0;
  if (a.line && b.line && !sameLine(a.line, b.line)) return 0;
  // Many trains run one line: in one category, the nearest copies pair
  // first.
  return a.line && b.line && a.category != null && a.category === b.category
    ? 1 - km / (2 * MATCH_RADIUS_KM)
    : 0;
}

/** Whether two copies are the same physical train. */
export function sameTrain(a, b) {
  return matchStrength(a, b) > 0;
}

/**
 * Grid columns either side of a copy's that reach MATCH_RADIUS_KM east and
 * west of it, measured on the poleward edge of its row's neighbours.
 * @param {number} lat
 * @returns {number}
 */
function columnSpan(lat) {
  const poleward = Math.min(89, Math.abs(lat) + CELL_DEG);
  const cellKm = CELL_DEG * 111.32 * Math.cos((poleward * Math.PI) / 180);
  return Math.max(1, Math.ceil(MATCH_RADIUS_KM / cellKm));
}

/**
 * Groups of two or more copies that are one train, at most one copy per
 * feed: two trains of one feed are two trains, even where a third feed's
 * copy resembles both (coupled TGVs). The strongest matches are joined
 * first. Numbered copies are compared wherever they are, the others only
 * within MATCH_RADIUS_KM's reach on the grid.
 * @param {object[]} copies
 * @returns {object[][]}
 */
export function matchCopies(copies) {
  const cells = new Map();
  const cellOf = (lat, lon) =>
    `${Math.floor(lat / CELL_DEG)}|${Math.floor(lon / CELL_DEG)}`;
  copies.forEach((copy, i) => {
    if (!Number.isFinite(copy.lat) || !Number.isFinite(copy.lon)) return;
    const key = cellOf(copy.lat, copy.lon);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  });
  const pairs = [];
  // Numbered copies pair through their number, wherever they are.
  const byNumber = new Map();
  copies.forEach((copy, i) => {
    if (!copy.number) return;
    if (!byNumber.has(copy.number)) byNumber.set(copy.number, []);
    byNumber.get(copy.number).push(i);
  });
  for (const list of byNumber.values())
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const strength = matchStrength(copies[list[x]], copies[list[y]]);
        if (strength > 0) pairs.push([strength, list[x], list[y]]);
      }
  // The others through the grid: only copies near each other.
  copies.forEach((copy, i) => {
    if (!Number.isFinite(copy.lat) || !Number.isFinite(copy.lon)) return;
    const row = Math.floor(copy.lat / CELL_DEG);
    const col = Math.floor(copy.lon / CELL_DEG);
    const span = columnSpan(copy.lat);
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -span; dc <= span; dc++)
        for (const j of cells.get(`${row + dr}|${col + dc}`) ?? []) {
          if (j <= i || (copy.number && copies[j].number)) continue;
          const strength = matchStrength(copy, copies[j]);
          if (strength > 0) pairs.push([strength, i, j]);
        }
  });
  pairs.sort((a, b) => b[0] - a[0]);
  const parent = copies.map((_, i) => i);
  const feeds = copies.map((copy) => new Set([copy.feedId]));
  const members = copies.map((_, i) => [i]);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const [, i, j] of pairs) {
    const a = find(i);
    const b = find(j);
    if (a === b || [...feeds[b]].some((feed) => feeds[a].has(feed))) continue;
    // Every copy must match every other: a copy resembling two trains (an
    // unnumbered train at a busy hub) never joins them into one.
    const all = members[a].every((x) =>
      members[b].every(
        (y) => (x === i && y === j) || matchStrength(copies[x], copies[y]) > 0,
      ),
    );
    if (!all) continue;
    parent[b] = a;
    for (const feed of feeds[b]) feeds[a].add(feed);
    members[a].push(...members[b]);
  }
  const groups = new Map();
  copies.forEach((copy, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(copy);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * A copy's score: `[position, line]`, compared in that order.
 * @param {object} copy
 * @returns {number[]}
 */
export function scoreCopy(copy) {
  return [POSITION_RANK[copy.position] ?? 0, copy.onShape === true ? 1 : 0];
}

function better(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The copy each group draws, keeping last time's choice unless another copy
 * scores strictly higher.
 * @param {object[][]} groups From matchCopies.
 * @param {Map<string, string>} [previous] copy key → key drawn last time.
 * @param {string|null} [held] A copy drawn whatever the scores: the train a
 *   first-person view holds.
 * @returns {{winners: Map<string, string>, hidden: Set<string>}}
 *   `winners`: every grouped copy's key → the key drawn for its train.
 */
export function chooseCopies(groups, previous = new Map(), held = null) {
  const winners = new Map();
  const hidden = new Set();
  for (const group of groups) {
    const scored = group.map((copy) => ({ copy, score: scoreCopy(copy) }));
    const keys = new Set(group.map((copy) => copy.key));
    const incumbentKey = group
      .map((copy) => previous.get(copy.key))
      .find((key) => key && keys.has(key));
    let best =
      scored.find(({ copy }) => copy.key === incumbentKey) ??
      scored.reduce((a, b) => (better(b.score, a.score) ? b : a));
    for (const candidate of scored)
      if (better(candidate.score, best.score)) best = candidate;
    best = scored.find(({ copy }) => copy.key === held) ?? best;
    for (const { copy } of scored) {
      winners.set(copy.key, best.copy.key);
      if (copy.key !== best.copy.key) hidden.add(copy.key);
    }
  }
  return { winners, hidden };
}

/**
 * The layer's duplicate filter: after each poll it matches the trains every
 * loaded feed carries, marks the copies not drawn (`entry.duplicate`), and
 * moves a selection that sat on a copy now hidden to the copy drawn, so the
 * card follows the same physical train (its feed line names the new
 * source). A held copy is never the one hidden, so the hold and the
 * selection stay on it.
 * @param {{state: object, parts: object,
 *   defer?: (fn: Function) => unknown}} context
 */
export function createDuplicateFilter({
  state,
  parts,
  defer = (fn) => setTimeout(fn, 0),
}) {
  let previous = new Map();
  let pending = false;
  let lastStats = { groups: 0, hidden: 0 };

  /** The comparable view of one drawn train. */
  function copyOf(entry) {
    const record = entry.record ?? {};
    const { number, line } = recordNumbers(record);
    return {
      key: entry.key,
      feedId: entry.feedId,
      lat: record.lat,
      lon: record.lon,
      number,
      line,
      category: entry.category ?? record.category ?? null,
      position: record.positionSource ?? 'gps',
      onShape: Number.isInteger(entry.path?.shapeIndex),
    };
  }

  /** Recompute which copies are drawn. Cheap enough for once per poll. */
  function refresh() {
    pending = false;
    const entries = [...state._trains.values()];
    const { winners, hidden } = chooseCopies(
      matchCopies(entries.map(copyOf)),
      previous,
      state._cockpitSubjectKey ?? null,
    );
    previous = winners;
    for (const entry of entries) {
      const duplicate = hidden.has(entry.key);
      if (entry.duplicate === duplicate) continue;
      entry.duplicate = duplicate;
      parts.rendering.paint(entry);
      parts.rendering.schedulePlayback(entry);
    }
    // A selection stays on its train: it moves to the copy now drawn.
    const selected = state._selectedKey;
    if (selected && hidden.has(selected)) {
      const drawn = winners.get(selected);
      if (drawn && state._trains.has(drawn)) parts.selection.selectTrain(drawn);
    }
    lastStats = {
      groups: new Set(winners.values()).size,
      hidden: hidden.size,
    };
    return lastStats;
  }

  /** Coalesce the refreshes of several feeds' polls into one. */
  function scheduleRefresh() {
    if (pending) return;
    pending = true;
    defer(() => {
      if (pending) refresh();
    });
  }

  return {
    refresh,
    scheduleRefresh,
    stats: () => ({ ...lastStats }),
  };
}

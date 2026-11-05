// NTSB aviation accident data (United States, 2008 onward) for the
// air-accidents layer. The NTSB publishes one large Access database (avall,
// about 97 MB zipped, 560 MB unpacked) and small weekly update databases
// (upDDMMM, about 1 MB). The store builds its compact record list from avall
// once, in the background, keeps it on disk, and from then on applies only
// the weekly updates, so the large file is read once per cache, not per day.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import MDBReader from 'mdb-reader';

export const NTSB_FILES_URL = 'https://data.ntsb.gov/avdata/FileDirectory';
const DOWNLOAD_URL = `${NTSB_FILES_URL}/DownloadFile?fileID=`;
// Bumped when the kept records change, so an old cache is rebuilt.
const STATE_VERSION = 3;
const MIB = 1024 * 1024;
const LIMITS = Object.freeze({
  listing: 2 * MIB,
  baselineZip: 400 * MIB,
  baselineMdb: 2048 * MIB,
  updateZip: 64 * MIB,
  updateMdb: 512 * MIB,
});

// Only technical columns are read. The aircraft table also holds owner and
// operator names and addresses, and other tables describe the crew: none of
// those columns or tables is ever requested.
const EVENT_COLUMNS = Object.freeze([
  'ev_id',
  'ntsb_no',
  'ev_type',
  'ev_date',
  'ev_time',
  'ev_tmzn',
  'ev_city',
  'ev_state',
  'ev_country',
  'ev_nr_apt_id',
  'dec_latitude',
  'dec_longitude',
  'inj_tot_f',
  'inj_tot_s',
  'inj_tot_m',
]);
const AIRCRAFT_COLUMNS = Object.freeze([
  'ev_id',
  'Aircraft_Key',
  'regis_no',
  'acft_make',
  'acft_model',
  'acft_year',
  'damage',
  'far_part',
  'dprt_apt_id',
  'dprt_city',
  'dest_apt_id',
  'dest_city',
  // Read only for airline (Part 121) flights, whose operator is a company.
  'oper_name',
]);

const text = (value, max = 80) => {
  if (value === null || value === undefined) return null;
  const out = String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  return out || null;
};
const count = (value) =>
  Number.isInteger(value) && value >= 0 && value < 100000 ? value : null;

/**
 * The files the NTSB download page lists, with their publication time.
 * @param {string} html
 * @returns {{name: string, date: number}[]}
 */
export function parseNtsbFileListing(html) {
  const files = [];
  const row =
    /<td id="fileName">\s*([^<]+?)\s*<\/td>\s*<td id="fileDate">\s*([^<]+?)\s*<\/td>/g;
  for (const [, name, stamp] of String(html).matchAll(row)) {
    if (!/^(avall|up\d{2}[A-Z]{3})\.zip$/.test(name)) continue;
    const match =
      /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/.exec(
        stamp,
      );
    if (!match) continue;
    const [, month, day, year, hour, minute, second, half] = match;
    const hours = (Number(hour) % 12) + (half === 'PM' ? 12 : 0);
    files.push({
      name,
      date: Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        hours,
        Number(minute),
        Number(second),
      ),
    });
  }
  return files;
}

/**
 * Unpack the first `.mdb` entry of a zip file on disk into `outPath`,
 * streaming, so the archive is never held in memory.
 * @param {string} zipPath
 * @param {string} outPath
 * @param {number} maxBytes Largest unpacked size accepted.
 */
export async function unzipMdbEntry(zipPath, outPath, maxBytes) {
  const handle = await fsp.open(zipPath, 'r');
  let entry;
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new Error('ntsb_zip_unreadable');
    const entries = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirAt = tail.readUInt32LE(eocd + 16);
    if (dirAt === 0xffffffff || dirAt + dirSize > size)
      throw new Error('ntsb_zip_unreadable');
    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirAt);
    let at = 0;
    for (let n = 0; n < entries && at + 46 <= dirSize; n++) {
      if (dir.readUInt32LE(at) !== 0x02014b50)
        throw new Error('ntsb_zip_unreadable');
      const nameLength = dir.readUInt16LE(at + 28);
      const name = dir.toString(
        'latin1',
        at + 46,
        Math.min(dirSize, at + 46 + nameLength),
      );
      const current = {
        flags: dir.readUInt16LE(at + 8),
        method: dir.readUInt16LE(at + 10),
        compressed: dir.readUInt32LE(at + 20),
        local: dir.readUInt32LE(at + 42),
      };
      at +=
        46 + nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32);
      if (/\.mdb$/i.test(name)) {
        entry = current;
        break;
      }
    }
    if (!entry || entry.flags & 0x1 || entry.compressed === 0xffffffff)
      throw new Error('ntsb_zip_unreadable');
    const local = Buffer.alloc(30);
    await handle.read(local, 0, 30, entry.local);
    if (local.readUInt32LE(0) !== 0x04034b50)
      throw new Error('ntsb_zip_unreadable');
    entry.start =
      entry.local + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (entry.start + entry.compressed > size)
      throw new Error('ntsb_zip_unreadable');
  } finally {
    await handle.close();
  }
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error('ntsb_zip_unreadable');
  let written = 0;
  const cap = new Transform({
    transform(chunk, _encoding, done) {
      written += chunk.length;
      done(written > maxBytes ? new Error('ntsb_mdb_too_large') : null, chunk);
    },
  });
  const source = fs.createReadStream(zipPath, {
    start: entry.start,
    end: entry.start + entry.compressed - 1,
  });
  const stages = [source];
  if (entry.method === 8) stages.push(zlib.createInflateRaw());
  stages.push(cap, fs.createWriteStream(outPath));
  await pipeline(...stages);
}

function isoDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

function clock(value) {
  const hhmm = Number.isInteger(value) ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(hhmm) || hhmm < 0) return null;
  const hours = Math.floor(hhmm / 100);
  const minutes = hhmm % 100;
  return hours < 24 && minutes < 60
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    : null;
}

function place(airport, city) {
  const code = text(airport, 8);
  const name = text(city, 60);
  if (name && code) return `${name} (${code})`;
  return name || code;
}

/**
 * US accidents and incidents with a position, one record per NTSB event,
 * in the shared air-accident record shape.
 * @param {{events: object[], aircraft: object[]}} tables Rows of the
 *   `events` and `aircraft` tables, technical columns only.
 * @returns {{records: object[], seen: string[]}} The records and every event
 *   id the tables describe (an update that drops an event from the map).
 */
export function normalizeNtsbTables({ events = [], aircraft = [] }) {
  const planes = new Map();
  for (const row of aircraft) {
    const id = text(row.ev_id, 20);
    if (!id) continue;
    const list = planes.get(id) || [];
    list.push(row);
    planes.set(id, list);
  }
  const records = [];
  const seen = [];
  for (const row of events) {
    const id = text(row.ev_id, 20);
    if (!id) continue;
    seen.push(id);
    const lat = Number(row.dec_latitude);
    const lon = Number(row.dec_longitude);
    const fatalities = count(row.inj_tot_f);
    if (
      (row.ev_type !== 'ACC' && row.ev_type !== 'INC') ||
      row.ev_country !== 'USA' ||
      row.dec_latitude === null ||
      row.dec_longitude === null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0)
    )
      continue;
    const rows = (planes.get(id) || []).sort(
      (a, b) => (a.Aircraft_Key ?? 0) - (b.Aircraft_Key ?? 0),
    );
    const first = rows[0] || {};
    const injuries = (count(row.inj_tot_s) || 0) + (count(row.inj_tot_m) || 0);
    const zone = text(row.ev_tmzn, 5);
    records.push({
      id: `ntsb:${id}`,
      source: 'ntsb',
      // NTSB records only the incidents US rules make reportable (engine
      // failure, fire, near collision, loss of control...): ICAO's serious
      // incidents, CENIPA's 'incidente grave'.
      kind: row.ev_type === 'INC' ? 'serious-incident' : 'accident',
      lat,
      lon,
      date: isoDate(row.ev_date),
      time: clock(row.ev_time),
      timeZone: zone && /^[A-Z]{2,5}$/.test(zone) ? zone : null,
      city: text(row.ev_city, 60),
      state: text(row.ev_state, 4),
      country: 'USA',
      aerodrome: text(row.ev_nr_apt_id, 8),
      approximate: false,
      fatalities,
      injuries: injuries || null,
      aircraft: rows.map((plane) => ({
        registration: text(plane.regis_no, 12),
        category: null,
        maker: text(plane.acft_make, 60),
        model: text(plane.acft_model, 40),
        icaoType: null,
        year: count(plane.acft_year),
        phase: null,
        operation: text(plane.far_part, 6),
        damage: text(plane.damage, 6),
      })),
      events: [],
      investigation: null,
      report: text(row.ntsb_no, 20),
      origin: place(first.dprt_apt_id, first.dprt_city),
      destination: place(first.dest_apt_id, first.dest_city),
      operator: first.far_part === '121' ? text(first.oper_name, 80) : null,
      name: null,
      url: null,
    });
  }
  return { records, seen };
}

/** Read the two tables from an NTSB database file, technical columns only. */
export async function readNtsbDatabase(mdbPath) {
  const reader = new MDBReader(await fsp.readFile(mdbPath));
  const columns = (table, wanted) => {
    const present = new Set(table.getColumnNames());
    return wanted.filter((name) => present.has(name));
  };
  const events = reader.getTable('events');
  const aircraft = reader.getTable('aircraft');
  return normalizeNtsbTables({
    events: events.getData({ columns: columns(events, EVENT_COLUMNS) }),
    aircraft: aircraft.getData({
      columns: columns(aircraft, AIRCRAFT_COLUMNS),
    }),
  });
}

/**
 * Disk-backed NTSB record store.
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   cacheDir?: string,
 *   userAgent?: string,
 *   readDatabase?: (mdbPath: string) => Promise<{records: object[], seen: string[]}>,
 *   onChange?: () => void,
 * }} [options]
 */
export function createNtsbStore({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'air-accidents'),
  userAgent = 'gods-eye-view',
  readDatabase = readNtsbDatabase,
  onChange = () => {},
} = {}) {
  const statePath = path.join(cacheDir, 'ntsb.json');
  let state;
  let baseline = null;
  let updating = null;

  async function download(name, target, maxBytes, timeout) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(`${DOWNLOAD_URL}${name}`, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': userAgent },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('ntsb_unavailable');
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) {
      await response.body.cancel();
      throw new Error('ntsb_file_too_large');
    }
    let received = 0;
    const cap = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        done(
          received > maxBytes ? new Error('ntsb_file_too_large') : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      cap,
      fs.createWriteStream(target),
    );
  }

  async function listing() {
    const signal = AbortSignal.timeout(30_000);
    const response = await fetchImpl(NTSB_FILES_URL, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': userAgent },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('ntsb_unavailable');
    }
    const body = await response.text();
    if (body.length > LIMITS.listing) throw new Error('ntsb_listing_too_large');
    return parseNtsbFileListing(body);
  }

  /** Download one zip, unpack its database and read it; temp files go away. */
  async function readFile(name, zipLimit, mdbLimit, timeout) {
    await fsp.mkdir(cacheDir, { recursive: true });
    const stem = path.join(cacheDir, `ntsb-${name}-${process.pid}`);
    try {
      await download(name, `${stem}.zip`, zipLimit, timeout);
      await unzipMdbEntry(`${stem}.zip`, `${stem}.mdb`, mdbLimit);
      await fsp.rm(`${stem}.zip`, { force: true });
      return await readDatabase(`${stem}.mdb`);
    } finally {
      await fsp.rm(`${stem}.zip`, { force: true });
      await fsp.rm(`${stem}.mdb`, { force: true });
    }
  }

  async function loadState() {
    if (state !== undefined) return state;
    try {
      const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      state =
        parsed?.version === STATE_VERSION && Array.isArray(parsed.records)
          ? parsed
          : null;
    } catch {
      state = null;
    }
    return state;
  }

  async function saveState(next) {
    await fsp.mkdir(cacheDir, { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(next));
    await fsp.rename(temp, statePath);
    state = next;
  }

  /** Apply the weekly files published after the state's last one, in order. */
  async function applyUpdates(current, files) {
    const pending = files
      .filter((file) => file.name !== 'avall.zip')
      .filter((file) => file.date > current.through)
      .sort((a, b) => a.date - b.date);
    let next = current;
    for (const file of pending) {
      const { records, seen } = await readFile(
        file.name,
        LIMITS.updateZip,
        LIMITS.updateMdb,
        120_000,
      );
      const byId = new Map(next.records.map((record) => [record.id, record]));
      for (const id of seen) byId.delete(`ntsb:${id}`);
      for (const record of records) byId.set(record.id, record);
      next = {
        ...next,
        through: file.date,
        checkedAt: now(),
        records: [...byId.values()],
      };
      await saveState(next);
    }
    return next;
  }

  async function buildBaseline() {
    const files = await listing();
    const full = files.find((file) => file.name === 'avall.zip');
    if (!full) throw new Error('ntsb_unavailable');
    const { records } = await readFile(
      'avall.zip',
      LIMITS.baselineZip,
      LIMITS.baselineMdb,
      30 * 60_000,
    );
    const first = {
      version: STATE_VERSION,
      baseline: full.date,
      through: full.date,
      checkedAt: now(),
      records,
    };
    await saveState(first);
    await applyUpdates(first, files);
    onChange();
  }

  /**
   * The NTSB records to serve now, or null while the first build runs. A
   * missing cache starts that build in the background; an existing one gets
   * the weekly files published since its last check.
   * @returns {Promise<object[]|null>}
   */
  async function records() {
    const current = await loadState();
    if (!current) {
      baseline ||= buildBaseline().finally(() => {
        baseline = null;
      });
      baseline.catch(() => {});
      return null;
    }
    try {
      updating ||= listing()
        .then((files) => applyUpdates(current, files))
        .finally(() => {
          updating = null;
        });
      return (await updating).records;
    } catch {
      return current.records;
    }
  }

  return { records };
}

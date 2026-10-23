/** Buenos Aires Data's published inventory, not a live camera feed. */
export const CABA_DATASET_URL =
  'https://data.buenosaires.gob.ar/dataset/camaras-fijas-control-vehicular';
export const CABA_CSV_URL =
  CABA_DATASET_URL + '/resource/juqdkmgo-311-resource/download';
export const CABA_LICENSE_URL =
  'https://creativecommons.org/licenses/by/2.5/ar/';
export const CABA_MAX_ROWS = 5000;

const headerKey = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

function cleanText(value) {
  if (typeof value !== 'string') throw new Error('Invalid inventory text');
  const text = value.trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\ufffd]/.test(text)) {
    throw new Error('Invalid inventory text');
  }
  return text;
}

function coordinate(value) {
  if (!/^-?\d+(?:[.,]\d+)?$/.test(value.trim())) {
    throw new Error('Invalid inventory coordinate');
  }
  return Number(value.trim().replace(',', '.'));
}

function validateRow(row) {
  const type = cleanText(row?.type);
  const location = cleanText(row?.location);
  const { latitude, longitude } = row;
  // A generous CABA envelope catches swapped axes and broken decimal commas.
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -34.8 ||
    latitude > -34.4 ||
    longitude < -58.6 ||
    longitude > -58.3
  ) {
    throw new Error('Inventory coordinate outside CABA');
  }
  return { type, location, latitude, longitude };
}

// Quoted delimiters, escaped quotes, CRLF and quoted newlines are parsed before
// validating the four required fields. Malformed input fails as a whole.
function csvRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const pushField = () => {
    row.push(field);
    if (row.length > 64) throw new Error('Too many CSV columns');
    field = '';
    closed = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > CABA_MAX_ROWS + 1) {
      throw new Error('Too many inventory rows');
    }
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
    } else if (char === delimiter) {
      pushField();
    } else if (char === '\r' || char === '\n') {
      pushRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else if (char === '"' && !field && !closed) {
      quoted = true;
    } else {
      if (closed || char === '"') throw new Error('Malformed CSV quoting');
      field += char;
    }
    if (field.length > 4096) throw new Error('CSV field too long');
  }
  if (quoted) throw new Error('Unterminated CSV field');
  if (field || row.length || closed) pushRow();
  return rows;
}

/** Parse the official CSV; reject schema drift instead of reporting zero sites. */
export function parseCabaTrafficCsv(input) {
  if (typeof input !== 'string' || input.length > 2 * 1024 * 1024) {
    throw new Error('Invalid inventory CSV');
  }
  const text = input.replace(/^\ufeff/, '');
  const header = text.split(/[\r\n]/, 1)[0];
  const delimiter = header.includes(';')
    ? ';'
    : header.includes('\t')
      ? '\t'
      : ',';
  const rows = csvRows(text, delimiter);
  const keys = (rows.shift() || []).map(headerKey);
  const required = ['tipo_de_fiscalizador', 'ubicacion', 'latitud', 'longitud'];
  if (
    new Set(keys).size !== keys.length ||
    required.some((key) => !keys.includes(key)) ||
    !rows.length
  ) {
    throw new Error('Invalid inventory schema or empty inventory');
  }
  const indices = required.map((key) => keys.indexOf(key));
  return rows.map((row) => {
    if (row.length !== keys.length) throw new Error('Invalid CSV row width');
    const [type, location, latitude, longitude] = indices.map((i) => row[i]);
    return validateRow({
      type,
      location,
      latitude: coordinate(latitude),
      longitude: coordinate(longitude),
    });
  });
}

/** Convert a validated inventory snapshot into point features with provenance. */
export function cabaTrafficFeatures(snapshot) {
  if (
    !Array.isArray(snapshot?.rows) ||
    !snapshot.rows.length ||
    snapshot.rows.length > CABA_MAX_ROWS ||
    !Number.isFinite(snapshot.fetchedAt) ||
    snapshot.fetchedAt <= 0 ||
    snapshot.fetchedAt > 8.64e15
  ) {
    throw new Error('Invalid inventory snapshot');
  }
  const seen = new Set();
  return snapshot.rows.flatMap((raw) => {
    const row = validateRow(raw);
    const { type, location, latitude, longitude } = row;
    // No stable source ID is published. Preserve distinct colocated devices;
    // only identical rows collapse, independently of their order in the CSV.
    const id = 'caba:' + JSON.stringify([type, location, latitude, longitude]);
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: {
          name: location,
          fiscalizador: type,
          data_kind: 'Published location inventory',
          operational_status: 'Not provided by source',
          imagery: 'Not provided by source',
          source: 'Gobierno de la Ciudad de Buenos Aires / Buenos Aires Data',
          source_url: CABA_DATASET_URL,
          license: 'CC-BY-2.5-AR',
          license_url: CABA_LICENSE_URL,
          catalog_retrieved_at: new Date(snapshot.fetchedAt).toISOString(),
        },
      },
    ];
  });
}

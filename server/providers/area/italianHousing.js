import { enqueueNominatim } from '../regional/place.js';

const official = 'https://www1.agenziaentrate.gov.it/servizi/geopoi_omi/';
const unavailable = (reason) => ({ status: 'unavailable', reason });
const normalize = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

function inRing(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}
/** Real OMI polygons, including holes: never assign the nearest zone across a boundary. */
export function containsOmiPoint(geometry, point) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  return polygons.some(
    (rings) =>
      rings.length &&
      inRing(rings[0], point) &&
      !rings.slice(1).some((ring) => inRing(ring, point)),
  );
}

const clean = (text) =>
  text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
const types = [
  'Abitazioni civili',
  'Abitazioni di tipo economico',
  'Ville e Villini',
  'Abitazioni signorili',
];
const labels = [
  'Standard apartments',
  'Economy apartments',
  'Villas',
  'Premium apartments',
];
/** Fail closed if official HTML changes or only non-residential quotations exist. */
export function parseOmiQuotation(html) {
  if (/captcha|g-recaptcha/i.test(html)) return null;
  const rows = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (
      cells.length !== 8 ||
      !/vmmin/.test(cells[2][1]) ||
      !/vmmax/.test(cells[3][1])
    )
      continue;
    const type = clean(cells[0][2]).replace(/\*/g, '').trim();
    const rank = types.findIndex(
      (candidate) => normalize(candidate) === normalize(type),
    );
    const condition = clean(cells[1][2]);
    const minimum = Number(clean(cells[2][2]).replace(',', '.')),
      maximum = Number(clean(cells[3][2]).replace(',', '.'));
    const surface = clean(cells[4][2]);
    if (
      rank < 0 ||
      condition.toUpperCase() !== 'NORMALE' ||
      !(minimum > 0) ||
      !(maximum >= minimum) ||
      !['L', 'N'].includes(surface)
    )
      continue;
    rows.push({
      minimum,
      maximum,
      value: (minimum + maximum) / 2,
      propertyType: labels[rank],
      surface: surface === 'L' ? 'gross floor area' : 'net floor area',
      rank,
    });
  }
  return rows.sort((a, b) => a.rank - b.rank)[0] || null;
}

/** Small bounded metadata cache. Quotations and polygons stay server-side. */
export function createItalianHousingProvider({ json, text }) {
  const cache = new Map();
  async function metadata(key, read) {
    const saved = cache.get(key);
    if (saved && Date.now() < saved.expires) return saved.value;
    const value = await read();
    if (cache.size >= 24) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + 6 * 3600000 });
    return value;
  }
  return async (point) => {
    const raw =
      process.env.AREA_HOUSING_NOMINATIM_URL ||
      'https://nominatim.openstreetmap.org/reverse';
    const reverse = new URL(raw);
    if (
      !['https:', 'http:'].includes(reverse.protocol) ||
      reverse.search ||
      reverse.hash ||
      reverse.username ||
      reverse.password
    )
      throw new Error('Invalid municipality lookup configuration');
    reverse.search = new URLSearchParams({
      format: 'jsonv2',
      lat: point.lat,
      lon: point.lon,
      zoom: '10',
      'accept-language': 'it',
    }).toString();
    const location = await enqueueNominatim(() => json(reverse.href), {
      bounded: true,
    });
    const address = location.address;
    if (address?.country_code !== 'it') return null;
    const province = address['ISO3166-2-lvl6']?.match(/^IT-([A-Z]{2})$/)?.[1];
    const names = [
      address.city,
      address.town,
      address.village,
      address.municipality,
    ]
      .filter(Boolean)
      .map(normalize);
    if (!province || !names.length)
      return unavailable(
        'OMI municipality could not be identified reliably at this point.',
      );
    const municipalities = await metadata(`province:${province}`, () =>
      json(`${official}zoneomi.php?richiesta=2&prov=${province}`),
    );
    const municipality = municipalities.find((row) =>
      names.includes(normalize(row.DIZIONE)),
    );
    if (!/^[A-Z][0-9]{3}$/.test(municipality?.CODCOM || ''))
      return unavailable(
        'No exact match in the official OMI municipality list.',
      );
    const periods = await metadata('periods', () =>
      json(`${official}zoneomi.php?richiesta=5`),
    );
    const semester = periods
      .map((row) => row.SEMESTRE)
      .filter((value) => /^20\d{2}[12]$/.test(value))
      .sort()
      .at(-1);
    if (!semester) throw new Error('OMI semester unavailable');
    const code = municipality.CODCOM;
    const collection = await metadata(`zones:${code}:${semester}`, () =>
      json(
        `${official}zoneomi.php?richiesta=6&codcom=${code}&semestre=${semester}`,
        {},
        16 * 1024 * 1024,
      ),
    );
    const zones =
      collection.dat?.features?.filter((feature) =>
        containsOmiPoint(feature.geometry, point),
      ) || [];
    const zoneCodes = [
      ...new Set(zones.map((feature) => feature.properties?.zona)),
    ];
    if (zoneCodes.length !== 1 || !/^[A-Z][0-9]{1,3}$/.test(zoneCodes[0]))
      return unavailable('No unambiguous OMI zone polygon covers this point.');
    const zone = zoneCodes[0];
    const links = await metadata(`links:${code}:${semester}:${zone}`, () =>
      json(
        `${official}zoneomi.php?richiesta=8&codcom=${code}&semestre=${semester}&zo=${zone}`,
      ),
    );
    const residential = links.find(
      (row) => row.DESCR_TIPOLOGIA === 'Residenziale',
    );
    if (!/^[A-Z]{2}[0-9]{8}$/.test(residential?.LINK_ZONA || ''))
      return unavailable('OMI has no residential quotations for this zone.');
    const sourceUrl = `${official}stampaomi.php?${code}/${residential.LINK_ZONA}/${semester}/R/${zone}/${point.lon.toFixed(6)}/${point.lat.toFixed(6)}`;
    const html = await text(sourceUrl);
    const quote = parseOmiQuotation(html);
    if (!quote)
      return unavailable(
        'No usable OMI residential range in normal condition; the source may require interactive access.',
      );
    const year = semester.slice(0, 4),
      half = semester.slice(4);
    // Ensure the values returned are for the requested zone and semester.
    if (
      !new RegExp(`Anno\\s+${year}`).test(html) ||
      !new RegExp(`Semestre\\s+${half}`).test(html) ||
      !html.includes(`>${zone}</span>`)
    )
      throw new Error('OMI quotation identity mismatch');
    return {
      status: 'available',
      ...quote,
      unit: 'EUR/m²',
      date: `${year}-H${half}`,
      area: `${municipality.DIZIONE} · OMI ${zone}`,
      source: 'Agenzia delle Entrate · OMI',
      sourceUrl,
      resolution: `OMI zone · ${quote.propertyType}, normal condition, ${quote.surface}`,
      warning:
        'Official quotation range, not recorded sale prices. The index uses its midpoint as an explicit preference proxy; it is not a property valuation.',
      licence:
        'Agenzia delle Entrate OMI terms · mandatory attribution; original data not redistributed',
    };
  };
}

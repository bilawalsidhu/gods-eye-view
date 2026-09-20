import { MID_COUNTRIES } from './ais-mid-table.js';

/**
 * Decodes the destination field a crew types into the AIS transponder.
 *
 * There is no standard for this field. Real traffic carries UN/LOCODEs
 * ("NLRTM"), plain port names ("ROTTERDAM"), local spellings ("ANTWERPEN"),
 * routes ("ROTTERDAM>HAMBURG") and free text ("SWEDISH SAR VESSEL"). Decoding
 * is therefore best-effort and always reports how confident it is.
 *
 * A LOCODE is two ISO-3166 letters plus a three-letter place code, so the
 * country is always recoverable even when the port is not in the table below —
 * "Germany (RSK)" is a worse answer than "Rostock" but a far better one than
 * five opaque letters.
 */

/** ISO alpha-2 → country name, derived from the MID table already shipped. */
/**
 * Several ISO codes carry more than one MID, because overseas territories get
 * their own: US covers both "Alaska" and "United States of America", FR covers
 * Adelie Land and the Kerguelen Islands. Taking whichever MID sorted first
 * would label a New York arrival as Alaskan, so the sovereign name wins.
 */
const ISO_CANONICAL = Object.freeze({
  US: 'United States',
  GB: 'United Kingdom',
  FR: 'France',
  PT: 'Portugal',
});

const ISO_COUNTRIES = (() => {
  const map = new Map();
  for (const entry of Object.values(MID_COUNTRIES)) {
    const [iso2, name] = entry;
    if (!iso2) continue;
    if (ISO_CANONICAL[iso2]) {
      map.set(iso2, ISO_CANONICAL[iso2]);
      continue;
    }
    if (!map.has(iso2)) map.set(iso2, name);
  }
  return map;
})();

/**
 * Major ports by UN/LOCODE.
 *
 * Deliberately a curated subset, not a mirror of the full UN/LOCODE list:
 * every entry here is one whose identity is unambiguous. An unlisted code
 * falls back to the country decode rather than to a guess.
 */
const PORTS = Object.freeze({
  // Northern Europe
  NLRTM: 'Rotterdam',
  NLAMS: 'Amsterdam',
  NLEEM: 'Eemshaven',
  BEANR: 'Antwerp',
  BEZEE: 'Zeebrugge',
  DEHAM: 'Hamburg',
  DEBRV: 'Bremerhaven',
  DEWVN: 'Wilhelmshaven',
  GBLON: 'London',
  GBIMM: 'Immingham',
  GBSOU: 'Southampton',
  GBFXT: 'Felixstowe',
  GBTEE: 'Teesport',
  FRLEH: 'Le Havre',
  FRDKK: 'Dunkirk',
  FRMRS: 'Marseille',
  PLGDN: 'Gdansk',
  PLGDY: 'Gdynia',
  DKAAR: 'Aarhus',
  DKCPH: 'Copenhagen',
  SEGOT: 'Gothenburg',
  SESTO: 'Stockholm',
  NOOSL: 'Oslo',
  NOBGO: 'Bergen',
  FIHEL: 'Helsinki',
  FIKTK: 'Kotka',
  EETLL: 'Tallinn',
  LVRIX: 'Riga',
  LTKLJ: 'Klaipeda',
  RULED: 'St Petersburg',
  IEDUB: 'Dublin',
  ISREY: 'Reykjavik',
  // Southern Europe
  ITGOA: 'Genoa',
  ITTRS: 'Trieste',
  ITGIT: 'Gioia Tauro',
  ESALG: 'Algeciras',
  ESBCN: 'Barcelona',
  ESVLC: 'Valencia',
  PTLIS: 'Lisbon',
  PTSIE: 'Sines',
  GRPIR: 'Piraeus',
  MTMAR: 'Marsaxlokk',
  TRAMB: 'Ambarli',
  // Middle East / Africa
  AEJEA: 'Jebel Ali',
  AEAUH: 'Abu Dhabi',
  AEFJR: 'Fujairah',
  SAJED: 'Jeddah',
  SARUH: 'Riyadh',
  OMSLL: 'Salalah',
  EGPSD: 'Port Said',
  EGSUZ: 'Suez',
  ZADUR: 'Durban',
  ZACPT: 'Cape Town',
  ZARCB: 'Richards Bay',
  MAPTM: 'Tanger Med',
  NGLOS: 'Lagos',
  // Asia
  SGSIN: 'Singapore',
  MYPKG: 'Port Klang',
  MYTPP: 'Tanjung Pelepas',
  CNSHA: 'Shanghai',
  CNNGB: 'Ningbo',
  CNSZX: 'Shenzhen',
  CNQIN: 'Qingdao',
  CNTXG: 'Tianjin',
  CNDLC: 'Dalian',
  CNCAN: 'Guangzhou',
  CNXMN: 'Xiamen',
  HKHKG: 'Hong Kong',
  TWKHH: 'Kaohsiung',
  TWTXG: 'Taichung',
  TWMLI: 'Mailiao',
  KRPUS: 'Busan',
  KRINC: 'Incheon',
  KRKAN: 'Gwangyang',
  JPYOK: 'Yokohama',
  JPTYO: 'Tokyo',
  JPNGO: 'Nagoya',
  JPUKB: 'Kobe',
  JPOSA: 'Osaka',
  JPCHB: 'Chiba',
  VNSGN: 'Ho Chi Minh City',
  VNHPH: 'Haiphong',
  THLCH: 'Laem Chabang',
  IDJKT: 'Jakarta',
  IDSUB: 'Surabaya',
  PHMNL: 'Manila',
  INNSA: 'Nhava Sheva',
  INMUN: 'Mundra',
  INMAA: 'Chennai',
  LKCMB: 'Colombo',
  BDCGP: 'Chittagong',
  PKKHI: 'Karachi',
  // Americas
  USNYC: 'New York',
  USLAX: 'Los Angeles',
  USLGB: 'Long Beach',
  USOAK: 'Oakland',
  USSEA: 'Seattle',
  USSFO: 'San Francisco',
  USHOU: 'Houston',
  USNOL: 'New Orleans',
  USSAV: 'Savannah',
  USCHS: 'Charleston',
  USBAL: 'Baltimore',
  USMIA: 'Miami',
  CAVAN: 'Vancouver',
  CAMTR: 'Montreal',
  CAHAL: 'Halifax',
  MXZLO: 'Manzanillo',
  MXVER: 'Veracruz',
  PABLB: 'Balboa',
  PACOL: 'Colon',
  BRSSZ: 'Santos',
  BRRIG: 'Rio Grande',
  BRPNG: 'Paranagua',
  ARBUE: 'Buenos Aires',
  CLVAP: 'Valparaiso',
  PECLL: 'Callao',
  COCTG: 'Cartagena',
  // Oceania
  AUSYD: 'Sydney',
  AUMEL: 'Melbourne',
  AUBNE: 'Brisbane',
  AUFRE: 'Fremantle',
  AUNTL: 'Newcastle',
  AUBUY: 'Bunbury',
  AUABP: 'Abbot Point',
  AUPKL: 'Port Kembla',
  AUHAY: 'Hay Point',
  AUGLT: 'Gladstone',
  AUPHE: 'Port Hedland',
  AUDPO: 'Dampier',
  NZAKL: 'Auckland',
  NZTRG: 'Tauranga',
});

/** Plain port names that appear as free text, mapped to a country. */
const NAMED_PORTS = Object.freeze({
  ROTTERDAM: ['Rotterdam', 'NL'],
  AMSTERDAM: ['Amsterdam', 'NL'],
  DORDRECHT: ['Dordrecht', 'NL'],
  EEMSHAVEN: ['Eemshaven', 'NL'],
  HARLINGEN: ['Harlingen', 'NL'],
  TERNEUZEN: ['Terneuzen', 'NL'],
  VLISSINGEN: ['Vlissingen', 'NL'],
  DELFZIJL: ['Delfzijl', 'NL'],
  ANTWERPEN: ['Antwerp', 'BE'],
  ANTWERP: ['Antwerp', 'BE'],
  GENT: ['Ghent', 'BE'],
  HAMBURG: ['Hamburg', 'DE'],
  BREMERHAVEN: ['Bremerhaven', 'DE'],
  ROSTOCK: ['Rostock', 'DE'],
  KIEL: ['Kiel', 'DE'],
  EMDEN: ['Emden', 'DE'],
  GDANSK: ['Gdansk', 'PL'],
  GDYNIA: ['Gdynia', 'PL'],
  SZCZECIN: ['Szczecin', 'PL'],
  GENOVA: ['Genoa', 'IT'],
  GENOA: ['Genoa', 'IT'],
  LIVORNO: ['Livorno', 'IT'],
  NAPOLI: ['Naples', 'IT'],
  'LE HAVRE': ['Le Havre', 'FR'],
  DUNKERQUE: ['Dunkirk', 'FR'],
  MARSEILLE: ['Marseille', 'FR'],
  HONGKONG: ['Hong Kong', 'HK'],
  'HONG KONG': ['Hong Kong', 'HK'],
  SINGAPORE: ['Singapore', 'SG'],
  SHANGHAI: ['Shanghai', 'CN'],
  BUSAN: ['Busan', 'KR'],
  YOKOHAMA: ['Yokohama', 'JP'],
  GOTHENBURG: ['Gothenburg', 'SE'],
  GOTEBORG: ['Gothenburg', 'SE'],
  OSLO: ['Oslo', 'NO'],
  BERGEN: ['Bergen', 'NO'],
  COPENHAGEN: ['Copenhagen', 'DK'],
  HELSINKI: ['Helsinki', 'FI'],
  TALLINN: ['Tallinn', 'EE'],
  LONDON: ['London', 'GB'],
  IMMINGHAM: ['Immingham', 'GB'],
  SOUTHAMPTON: ['Southampton', 'GB'],
  NEWCASTLE: ['Newcastle', 'AU'],
  DINTELHAVEN: ['Dintelhaven', 'NL'],
  BOTLEK: ['Botlek', 'NL'],
  MAASVLAKTE: ['Maasvlakte', 'NL'],
  'NEW YORK CITY': ['New York', 'US'],
  'NEW YORK': ['New York', 'US'],
  HOUSTON: ['Houston', 'US'],
  'SAN FRANCISCO': ['San Francisco', 'US'],
});

/**
 * Decodes an AIS destination string.
 *
 * @returns {{text:string, port:string, country:string, countryCode:string,
 *   confidence:'LOCODE'|'PORT'|'COUNTRY'|'RAW'}}
 */
export function decodeDestination(raw) {
  const text = String(raw ?? '')
    // AIS pads its fixed-width text fields with '@'; left in place it turns
    // "US SFO" into "US SFO AN@@@@@@@@@" and defeats every match below.
    .replace(/@+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  const empty = {
    text: '',
    port: '',
    country: '',
    countryCode: '',
    confidence: 'RAW',
  };
  if (!text) return empty;

  // Routes are written "A>B", "A-B" or "A VIA B" — the leg that matters is the
  // one being sailed to, which is the last segment.
  const leg = text
    .split(/\s*(?:>|=>|->|\bVIA\b)\s*/)
    .pop()
    .trim();
  const cleaned = leg.replace(/^(FOR|TO|DEST|DESTINATION)[\s:.]+/, '').trim();
  if (!cleaned) return { ...empty, text };

  const named = NAMED_PORTS[cleaned];
  if (named) {
    return {
      text,
      port: named[0],
      countryCode: named[1],
      country: ISO_COUNTRIES.get(named[1]) || '',
      confidence: 'PORT',
    };
  }

  const compact = cleaned.replace(/[^A-Z0-9]/g, '');
  // Crews append berth and cargo notes after the code ("US SFO AN", "NLRTM B3").
  // Trust a longer string only when its first five letters are a port we know;
  // guessing from an unrecognised prefix would invent destinations.
  if (compact.length > 5 && /^[A-Z]{5}/.test(compact)) {
    const prefix = compact.slice(0, 5);
    if (PORTS[prefix]) {
      const countryCode = prefix.slice(0, 2);
      return {
        text,
        port: PORTS[prefix],
        countryCode,
        country: ISO_COUNTRIES.get(countryCode) || '',
        confidence: 'LOCODE',
      };
    }
  }
  if (/^[A-Z]{5}$/.test(compact)) {
    const countryCode = compact.slice(0, 2);
    const country = ISO_COUNTRIES.get(countryCode) || '';
    const port = PORTS[compact] || '';
    if (port) return { text, port, country, countryCode, confidence: 'LOCODE' };
    // Only claim a country when those two letters are a real ISO code; "SWEDI"
    // must not be read as Sweden plus three letters of noise.
    if (country)
      return { text, port: '', country, countryCode, confidence: 'COUNTRY' };
  }
  return { ...empty, text };
}

/**
 * Long official country names read badly mid-sentence — "United States of
 * America-flagged 29m vessel". Prose uses the short form.
 */
const SHORT_COUNTRIES = Object.freeze({
  'United States of America': 'United States',
  'Russian Federation': 'Russia',
  'Korea (Republic of)': 'South Korea',
  "Korea (Democratic People's Republic of)": 'North Korea',
  'Iran (Islamic Republic of)': 'Iran',
  'Syrian Arab Republic': 'Syria',
  'Viet Nam': 'Vietnam',
  'Taiwan (Province of China)': 'Taiwan',
  'United Republic of Tanzania': 'Tanzania',
  'Venezuela (Bolivarian Republic of)': 'Venezuela',
  'Bolivia (Plurinational State of)': 'Bolivia',
  'Moldova (Republic of)': 'Moldova',
  'Brunei Darussalam': 'Brunei',
  'Hong Kong, China': 'Hong Kong',
  'Macao, China': 'Macao',
});

/** Short, sentence-friendly country name. */
export function shortCountry(name) {
  const text = String(name || '').trim();
  return SHORT_COUNTRIES[text] || text;
}

/** Human-readable place, as specific as the decode allows. */
export function destinationLabel(decoded) {
  if (!decoded || !decoded.text) return '';
  if (decoded.port && decoded.country)
    return `${decoded.port}, ${decoded.country}`;
  if (decoded.port) return decoded.port;
  if (decoded.country) return `${decoded.country} (${decoded.text})`;
  return decoded.text;
}

// The country an aircraft is registered in, for the flag on its Context card:
// from the block of ICAO 24-bit addresses the country was allocated (ICAO
// Annex 10, Vol. III), else from the origin country its feed reports. Only
// the larger allocations are listed. A reported Bermuda or Cayman registry
// can identify a territory within the UK allocation.

/** [first, last, ISO 3166-1 alpha-2] address blocks, as hex numbers. */
const BLOCKS = Object.freeze([
  [0x008000, 0x00ffff, 'ZA'],
  [0x010000, 0x017fff, 'EG'],
  [0x0d0000, 0x0d7fff, 'MX'],
  [0x100000, 0x1fffff, 'RU'],
  [0x300000, 0x33ffff, 'IT'],
  [0x340000, 0x37ffff, 'ES'],
  [0x380000, 0x3bffff, 'FR'],
  [0x3c0000, 0x3fffff, 'DE'],
  [0x400000, 0x43ffff, 'GB'],
  [0x440000, 0x447fff, 'AT'],
  [0x448000, 0x44ffff, 'BE'],
  [0x458000, 0x45ffff, 'DK'],
  [0x460000, 0x467fff, 'FI'],
  [0x468000, 0x46ffff, 'GR'],
  [0x470000, 0x477fff, 'HU'],
  [0x478000, 0x47ffff, 'NO'],
  [0x480000, 0x487fff, 'NL'],
  [0x488000, 0x48ffff, 'PL'],
  [0x490000, 0x497fff, 'PT'],
  [0x498000, 0x49ffff, 'CZ'],
  [0x4a0000, 0x4a7fff, 'RO'],
  [0x4a8000, 0x4affff, 'SE'],
  [0x4b0000, 0x4b7fff, 'CH'],
  [0x4b8000, 0x4bffff, 'TR'],
  [0x4ca000, 0x4cafff, 'IE'],
  [0x508000, 0x50ffff, 'UA'],
  [0x710000, 0x717fff, 'SA'],
  [0x718000, 0x71ffff, 'KR'],
  [0x738000, 0x73ffff, 'IL'],
  [0x760000, 0x767fff, 'PK'],
  [0x768000, 0x76ffff, 'SG'],
  [0x780000, 0x7bffff, 'CN'],
  [0x7c0000, 0x7fffff, 'AU'],
  [0x800000, 0x83ffff, 'IN'],
  [0x840000, 0x87ffff, 'JP'],
  [0x896000, 0x896fff, 'AE'],
  [0x8a0000, 0x8a7fff, 'ID'],
  [0xa00000, 0xafffff, 'US'],
  [0xc00000, 0xc3ffff, 'CA'],
  [0xc80000, 0xc87fff, 'NZ'],
  [0xe00000, 0xe3ffff, 'AR'],
  [0xe40000, 0xe7ffff, 'BR'],
]);

/** The country an ICAO 24-bit address was allocated to, or null. */
export function countryCodeForIcao24(icao24) {
  // A leading ~ marks a track id that is not an ICAO address (TIS-B,
  // non-ICAO): it belongs to no country's block.
  const hex = String(icao24 ?? '').trim();
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const address = Number.parseInt(hex, 16);
  for (const [first, last, code] of BLOCKS)
    if (address >= first && address <= last) return code;
  return null;
}

/** Codes Intl still names that are no longer countries, or not countries. */
const RETIRED_CODES = new Set([
  'AN',
  'BU',
  'CS',
  'DD',
  'DY',
  'EU',
  'EZ',
  'FX',
  'HV',
  'NH',
  'NT',
  'QO',
  'RH',
  'SU',
  'TP',
  'UK',
  'UN',
  'VD',
  'YD',
  'YU',
  'ZR',
  'ZZ',
]);
let namesToCodes = null;
/** The ISO code for an English country name, as feeds report it. */
export function countryCodeForName(name) {
  const wanted = String(name ?? '')
    .trim()
    .toLowerCase();
  if (!wanted) return null;
  if (!namesToCodes) {
    namesToCodes = new Map();
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++)
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const shown = names.of(code);
          // Retired codes (DD, FX…) share their successor's name.
          if (RETIRED_CODES.has(code)) continue;
          if (shown && shown !== code)
            namesToCodes.set(shown.toLowerCase(), code);
        }
    } catch {
      // Without Intl region names, only the address blocks give a country.
    }
    // How OpenSky and others spell a few of them.
    namesToCodes.set('republic of korea', 'KR');
    namesToCodes.set('russian federation', 'RU');
    namesToCodes.set('viet nam', 'VN');
    namesToCodes.set('iran, islamic republic of', 'IR');
  }
  return namesToCodes.get(wanted) || null;
}

/** An aircraft's registration country from its allocation and reported origin. */
export function aircraftCountryCode(record) {
  const allocation = countryCodeForIcao24(record?.icao24);
  if (allocation && allocation !== 'GB') return allocation;
  const registry = countryCodeForName(record?.originCountry);
  if (registry === 'BM' || registry === 'KY') return registry;
  return allocation || registry;
}

/** The flag emoji for an ISO 3166-1 alpha-2 code ('' for anything else). */
export function flagEmoji(code) {
  const value = String(code ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return '';
  return String.fromCodePoint(
    ...[...value].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
  );
}

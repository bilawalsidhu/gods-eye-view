// src/data/icaoCountry.js
/**
 * Registering state from a Mode S (ICAO 24-bit) address. ICAO Annex 10
 * Vol. III hands each state a block of addresses, and the state assigns them
 * to its aircraft — civil and military alike. So the hex alone names the
 * country that REGISTERED the airframe, which is a fallback for contacts the
 * feed carries no operator for (military rows rarely have adsb.lol's ownOp).
 *
 * It is an inference, not an operator: multinational fleets fly on one
 * member's addresses, and a transponder can be misconfigured. Callers label
 * it as coming from the address block.
 *
 * Ranges follow the Annex 10 allocation table as transcribed by tar1090
 * (flags.js). Addresses outside every block — the ICAO-reserved F0xxxx
 * blocks, non-ICAO `~` addresses from TIS-B/MLAT — return null.
 */

// [first, last, ISO 3166-1 alpha-2], sorted by first address.
const BLOCKS = [
  [0x004000, 0x0043ff, 'ZW'],
  [0x006000, 0x006fff, 'MZ'],
  [0x008000, 0x00ffff, 'ZA'],
  [0x010000, 0x017fff, 'EG'],
  [0x018000, 0x01ffff, 'LY'],
  [0x020000, 0x027fff, 'MA'],
  [0x028000, 0x02ffff, 'TN'],
  [0x030000, 0x0303ff, 'BW'],
  [0x032000, 0x032fff, 'BI'],
  [0x034000, 0x034fff, 'CM'],
  [0x035000, 0x0353ff, 'KM'],
  [0x036000, 0x036fff, 'CG'],
  [0x038000, 0x038fff, 'CI'],
  [0x03e000, 0x03efff, 'GA'],
  [0x040000, 0x040fff, 'ET'],
  [0x042000, 0x042fff, 'GQ'],
  [0x044000, 0x044fff, 'GH'],
  [0x046000, 0x046fff, 'GN'],
  [0x048000, 0x0483ff, 'GW'],
  [0x04a000, 0x04a3ff, 'LS'],
  [0x04c000, 0x04cfff, 'KE'],
  [0x050000, 0x050fff, 'LR'],
  [0x054000, 0x054fff, 'MG'],
  [0x058000, 0x058fff, 'MW'],
  [0x05a000, 0x05a3ff, 'MV'],
  [0x05c000, 0x05cfff, 'ML'],
  [0x05e000, 0x05e3ff, 'MR'],
  [0x060000, 0x0603ff, 'MU'],
  [0x062000, 0x062fff, 'NE'],
  [0x064000, 0x064fff, 'NG'],
  [0x068000, 0x068fff, 'UG'],
  [0x06a000, 0x06a3ff, 'QA'],
  [0x06c000, 0x06cfff, 'CF'],
  [0x06e000, 0x06efff, 'RW'],
  [0x070000, 0x070fff, 'SN'],
  [0x074000, 0x0743ff, 'SC'],
  [0x076000, 0x0763ff, 'SL'],
  [0x078000, 0x078fff, 'SO'],
  [0x07a000, 0x07a3ff, 'SZ'],
  [0x07c000, 0x07cfff, 'SD'],
  [0x080000, 0x080fff, 'TZ'],
  [0x084000, 0x084fff, 'TD'],
  [0x088000, 0x088fff, 'TG'],
  [0x08a000, 0x08afff, 'ZM'],
  [0x08c000, 0x08cfff, 'CD'],
  [0x090000, 0x090fff, 'AO'],
  [0x094000, 0x0943ff, 'BJ'],
  [0x096000, 0x0963ff, 'CV'],
  [0x098000, 0x0983ff, 'DJ'],
  [0x09a000, 0x09afff, 'GM'],
  [0x09c000, 0x09cfff, 'BF'],
  [0x09e000, 0x09e3ff, 'ST'],
  [0x0a0000, 0x0a7fff, 'DZ'],
  [0x0a8000, 0x0a8fff, 'BS'],
  [0x0aa000, 0x0aa3ff, 'BB'],
  [0x0ab000, 0x0ab3ff, 'BZ'],
  [0x0ac000, 0x0acfff, 'CO'],
  [0x0ae000, 0x0aefff, 'CR'],
  [0x0b0000, 0x0b0fff, 'CU'],
  [0x0b2000, 0x0b2fff, 'SV'],
  [0x0b4000, 0x0b4fff, 'GT'],
  [0x0b6000, 0x0b6fff, 'GY'],
  [0x0b8000, 0x0b8fff, 'HT'],
  [0x0ba000, 0x0bafff, 'HN'],
  [0x0bc000, 0x0bc3ff, 'VC'],
  [0x0be000, 0x0befff, 'JM'],
  [0x0c0000, 0x0c0fff, 'NI'],
  [0x0c2000, 0x0c2fff, 'PA'],
  [0x0c4000, 0x0c4fff, 'DO'],
  [0x0c6000, 0x0c6fff, 'TT'],
  [0x0c8000, 0x0c8fff, 'SR'],
  [0x0ca000, 0x0ca3ff, 'AG'],
  [0x0cc000, 0x0cc3ff, 'GD'],
  [0x0d0000, 0x0d7fff, 'MX'],
  [0x0d8000, 0x0dffff, 'VE'],
  [0x100000, 0x1fffff, 'RU'],
  [0x201000, 0x2013ff, 'NA'],
  [0x202000, 0x2023ff, 'ER'],
  [0x300000, 0x33ffff, 'IT'],
  [0x340000, 0x37ffff, 'ES'],
  [0x380000, 0x3bffff, 'FR'],
  [0x3c0000, 0x3fffff, 'DE'],
  [0x400000, 0x43ffff, 'GB'],
  [0x440000, 0x447fff, 'AT'],
  [0x448000, 0x44ffff, 'BE'],
  [0x450000, 0x457fff, 'BG'],
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
  [0x4c0000, 0x4c7fff, 'RS'],
  [0x4c8000, 0x4c83ff, 'CY'],
  [0x4ca000, 0x4cafff, 'IE'],
  [0x4cc000, 0x4ccfff, 'IS'],
  [0x4d0000, 0x4d03ff, 'LU'],
  [0x4d2000, 0x4d23ff, 'MT'],
  [0x4d4000, 0x4d43ff, 'MC'],
  [0x500000, 0x5003ff, 'SM'],
  [0x501000, 0x5013ff, 'AL'],
  [0x501c00, 0x501fff, 'HR'],
  [0x502c00, 0x502fff, 'LV'],
  [0x503c00, 0x503fff, 'LT'],
  [0x504c00, 0x504fff, 'MD'],
  [0x505c00, 0x505fff, 'SK'],
  [0x506c00, 0x506fff, 'SI'],
  [0x507c00, 0x507fff, 'UZ'],
  [0x508000, 0x50ffff, 'UA'],
  [0x510000, 0x5103ff, 'BY'],
  [0x511000, 0x5113ff, 'EE'],
  [0x512000, 0x5123ff, 'MK'],
  [0x513000, 0x5133ff, 'BA'],
  [0x514000, 0x5143ff, 'GE'],
  [0x515000, 0x5153ff, 'TJ'],
  [0x516000, 0x5163ff, 'ME'],
  [0x600000, 0x6003ff, 'AM'],
  [0x600800, 0x600bff, 'AZ'],
  [0x601000, 0x6013ff, 'KG'],
  [0x601800, 0x601bff, 'TM'],
  [0x680000, 0x6803ff, 'BT'],
  [0x681000, 0x6813ff, 'FM'],
  [0x682000, 0x6823ff, 'MN'],
  [0x683000, 0x6833ff, 'KZ'],
  [0x684000, 0x6843ff, 'PW'],
  [0x700000, 0x700fff, 'AF'],
  [0x702000, 0x702fff, 'BD'],
  [0x704000, 0x704fff, 'MM'],
  [0x706000, 0x706fff, 'KW'],
  [0x708000, 0x708fff, 'LA'],
  [0x70a000, 0x70afff, 'NP'],
  [0x70c000, 0x70c3ff, 'OM'],
  [0x70e000, 0x70efff, 'KH'],
  [0x710000, 0x717fff, 'SA'],
  [0x718000, 0x71ffff, 'KR'],
  [0x720000, 0x727fff, 'KP'],
  [0x728000, 0x72ffff, 'IQ'],
  [0x730000, 0x737fff, 'IR'],
  [0x738000, 0x73ffff, 'IL'],
  [0x740000, 0x747fff, 'JO'],
  [0x748000, 0x74ffff, 'LB'],
  [0x750000, 0x757fff, 'MY'],
  [0x758000, 0x75ffff, 'PH'],
  [0x760000, 0x767fff, 'PK'],
  [0x768000, 0x76ffff, 'SG'],
  [0x770000, 0x777fff, 'LK'],
  [0x778000, 0x77ffff, 'SY'],
  [0x780000, 0x7bffff, 'CN'],
  [0x7c0000, 0x7fffff, 'AU'],
  [0x800000, 0x83ffff, 'IN'],
  [0x840000, 0x87ffff, 'JP'],
  [0x880000, 0x887fff, 'TH'],
  [0x888000, 0x88ffff, 'VN'],
  [0x890000, 0x890fff, 'YE'],
  [0x894000, 0x894fff, 'BH'],
  [0x895000, 0x8953ff, 'BN'],
  [0x896000, 0x896fff, 'AE'],
  [0x897000, 0x8973ff, 'SB'],
  [0x898000, 0x898fff, 'PG'],
  [0x899000, 0x8993ff, 'TW'],
  [0x8a0000, 0x8a7fff, 'ID'],
  [0x900000, 0x9003ff, 'MH'],
  [0x901000, 0x9013ff, 'CK'],
  [0x902000, 0x9023ff, 'WS'],
  [0xa00000, 0xafffff, 'US'],
  [0xc00000, 0xc3ffff, 'CA'],
  [0xc80000, 0xc87fff, 'NZ'],
  [0xc88000, 0xc88fff, 'FJ'],
  [0xc8a000, 0xc8a3ff, 'NR'],
  [0xc8c000, 0xc8c3ff, 'LC'],
  [0xc8d000, 0xc8d3ff, 'TO'],
  [0xc8e000, 0xc8e3ff, 'KI'],
  [0xc90000, 0xc903ff, 'VU'],
  [0xe00000, 0xe3ffff, 'AR'],
  [0xe40000, 0xe7ffff, 'BR'],
  [0xe80000, 0xe80fff, 'CL'],
  [0xe84000, 0xe84fff, 'EC'],
  [0xe88000, 0xe88fff, 'PY'],
  [0xe8c000, 0xe8cfff, 'PE'],
  [0xe90000, 0xe90fff, 'UY'],
  [0xe94000, 0xe94fff, 'BO'],
];

/**
 * ISO 3166-1 alpha-2 code of the state whose ICAO block holds this address.
 * @param {string} icao24 Six hex digits, any case; a `~` (non-ICAO) address
 *   or anything else malformed returns null.
 * @returns {string|null}
 */
export function icaoCountryCode(icao24) {
  if (typeof icao24 !== 'string') return null;
  const hex = icao24.trim();
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const address = parseInt(hex, 16);
  let lo = 0;
  let hi = BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last, code] = BLOCKS[mid];
    if (address < first) hi = mid - 1;
    else if (address > last) lo = mid + 1;
    else return code;
  }
  return null;
}

const displayNames = new Map();

/**
 * The registering state's name in `locale` (Intl region names, so every UI
 * language gets it without catalog entries). Falls back to the ISO code where
 * Intl.DisplayNames is unavailable.
 * @param {string} icao24
 * @param {string} [locale='en'] An Intl locale tag.
 * @returns {string|null}
 */
export function icaoCountryName(icao24, locale = 'en') {
  const code = icaoCountryCode(icao24);
  if (!code) return null;
  try {
    let names = displayNames.get(locale);
    if (!names) {
      names = new Intl.DisplayNames([locale], { type: 'region' });
      displayNames.set(locale, names);
    }
    return names.of(code) || code;
  } catch {
    return code;
  }
}

/** Test seam: the block table, for ordering/overlap checks. */
export const _ICAO_BLOCKS_FOR_TEST = BLOCKS;

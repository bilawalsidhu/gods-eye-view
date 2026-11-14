# Country and airline libraries

The selected-aircraft card names the state of registry and the operator of a live contact. Two bundled libraries answer those questions. Each is a `catalog.json` built offline plus a pure, synchronous lookup, so the card needs no network for this data.

A contact carries an `icao24` hex address and a `callsign`. The ICAO 24-bit address block names the country. The leading three letters of an airline callsign name the operator.

## Countries

`src/data/countries/catalog.json` is an array sorted by `iso2`, keyed by ISO 3166-1 alpha-2. Each entry has these fields.

- `iso2`, `iso3`, `name`.
- `flag`, the flag emoji, computed from `iso2` as two regional-indicator symbols. No image is bundled.
- `regPrefixes`, the civil aircraft registration prefixes, `[]` when unknown.
- `icao24Ranges`, inclusive six-digit hex blocks, `[]` when the country has none.

`src/data/countries/index.js` exports three functions.

- `countryEntry(iso2)` resolves a code in any case, or returns `null`.
- `countryForIcao24(hex)` strips `0x` and spaces, reads one to six hex digits, and binary-searches the sorted block index built at module load. A `~` TIS-B address, a seventh digit or an address in no block returns `null`.
- `allCountries()` lists the catalog in `iso2` order.

## Airlines

`src/data/airlines/catalog.json` is an array sorted by `icao`, keyed by the ICAO three-letter designator. Each entry has these fields.

- `icao`, `iata`, `name`, `callsign` (the radiotelephony word) and `active`.
- `country`, an ISO alpha-2 code that joins the country library. It is `null` where the source row has no usable country.
- `tailColor`, a solid `#RRGGBB` for 28 major carriers, `null` for the rest.

`src/data/airlines/index.js` exports three functions.

- `airlineEntry(icao)` resolves a designator in any case, or returns `null`.
- `airlineForCallsign(callsign)` takes the leading letter run (`SWR100` gives `SWR`, `BAW23G` gives `BAW`) and resolves it. A registration such as `N123AB` has the run `N`, and a four-letter run such as `ABCD12` has four letters, so both return `null`.
- `allAirlines()` lists the catalog in `icao` order.

A guess is never shown. A contact whose address sits in no allocated block, or whose callsign names no airline, resolves to `null` and the card leaves the field out.

## The card

`aircraftTypeCardModel` in `src/layers/flights/typeCard.js` fills `country` from `countryForIcao24(icao24)` and `operator` from `airlineForCallsign(callsign)`. The card shows the operator name with a swatch of its tail colour when one is curated, and the flag with the country name.

## Sources and licences

| Data | Source | Terms |
| --- | --- | --- |
| Country codes and names | ISO 3166-1, read from the `all/all.csv` of lukes/ISO-3166-Countries-with-Regional-Codes | Facts. Only the name and the two codes are taken. |
| Address blocks | dump1090 `public_html/flags.js` `ICAO_Ranges`, generated from the allocation table of ICAO Annex 10 Vol III chapter 9 | Facts of the ICAO assignment. dump1090 is BSD licensed. |
| Registration prefixes | ITU Radio Regulations and ICAO Annex 7 nationality marks, as on the Wikipedia list of aircraft registration prefixes, curated in `scripts/country-reg-prefixes.mjs` | Facts. Partial by design. |
| Flag | Computed from the alpha-2 code | No asset bundled. |
| Airlines | OpenFlights `data/airlines.dat`, from <https://github.com/jpatokal/openflights> | Open Database License (ODbL) 1.0. |
| Tail colour | Curated in `scripts/airline-tail-colors.mjs` | A colour is a fact. Approximate, not sampled from a livery. |

The airline catalog is a derived database. It stays under ODbL 1.0 with the OpenFlights attribution wherever it is redistributed, and code that only reads it is not covered. The in-app Data credits carry the attribution. The country catalog holds facts only and needs no licence beyond the source credit.

No logo or livery image is bundled, because airline logos are trademarks. Adding liveries later needs CC0, public domain, CC BY or CC BY-SA files with a named author, as the aircraft type library requires.

## Rebuilding

```sh
node scripts/build-country-catalog.mjs [--force] [--offline]
node scripts/build-airline-catalog.mjs [--force] [--offline]
```

Build the country catalog first, because the airline builder reads it. Each builder caches every response under `.gev-cache/<name>-catalog/`, which is gitignored, through the shared `scripts/cached-fetch.mjs`. It derives its output from the cache and its inputs alone and writes a file only when the bytes change. `--force` ignores the cache and refetches. `--offline` fails on any cache miss, which proves a rerun reproduces without the network. Each builder runs its validator and exits non-zero on a validation failure or a coverage shortfall.

Name matching joins three spellings of one country. `NAME_ALIASES` and `DISPLAY_NAMES` in `scripts/country-sources.mjs` are the explicit map, shared by both builders. The country builder fails on any allocation block whose name is neither an ISO name, an alias nor a non-country block, so a new upstream spelling is caught at build time.

## Known gaps

The dump1090 table lacks blocks assigned or amended after it was last generated, among them Dominica, Saint Kitts and Nevis, Timor-Leste, Tuvalu, South Sudan, the Vatican and Palestine. It has no separate entry for Taiwan. A contact in any of those ranges resolves to `null`. Fixing it means adding a reviewed source for the missing blocks and rerunning the builder.

Registration prefixes are partial and cover most states. Territories, Taiwan, Hong Kong and Macao are `[]`.

OpenFlights stores a callsign word or a fragment in the country column of some rows, which shifts the columns, and a few names are not ISO countries. The catalog keeps those rows and leaves `country` null. Neither lookup uses `callsign` or `country` to find an airline, which keys on the designator alone.

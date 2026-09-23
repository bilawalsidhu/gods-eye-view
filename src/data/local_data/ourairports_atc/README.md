# OurAirports ATC frequency pack

Offline airport radio frequencies for the ATC feature (`src/data/ourAirportsAtc.js`)
— "which controlling position could the aircraft I am tracking be talking to,
and on what frequency" with no network dependency and no API key.

| File | Source dataset | Contents |
|------|----------------|----------|
| `frequencies.json` | `airports.csv` + `airport-frequencies.csv` | 9,562 airports · 16,509 frequencies |

**Source:** [OurAirports](https://ourairports.com/data/), via the canonical
mirror `https://davidmegginson.github.io/ourairports-data/`, fetched
2026-09-23T09:19:16Z (provenance is in the file's `meta` header).

**There is no commit to pin.** Unlike the other bundled packs, OurAirports is a
live, continuously community-edited database, not a versioned repository. The
fetch timestamp and the row counts in `meta.coverage` *are* the provenance, and
a rebuild on a later date is expected to differ.

**License:** public domain —
"[released into the public domain ... no need to credit us, though we appreciate
it](https://ourairports.com/data/)". We credit it anyway; see `DATA_SOURCES.md`.

**Curation** (`node scripts/build-atc-frequencies.mjs`, parameters also recorded
in `meta.curation`):

- Eight frequency classes kept, carried through **verbatim**:
  `TWR GND APP ATIS CNTR` (controlled) and `CTAF UNIC AFIS` (advisory).
  13,341 rows of other classes dropped — AWOS/ASOS are synthesised voice, and
  MISC/INFO/RDO/A-D/CLD/DEL are either not a phase or not a controlling
  position.
- Frequencies outside the 108.000–137.000 MHz VHF air band dropped (492 rows):
  HF, UHF military, ranges written as prose, blanks. 108–118 is the navaid band
  and is **kept** — an ATIS is routinely broadcast on a co-located VOR.
- Airports with no surviving frequency, or whose coordinates do not parse,
  dropped. Exact (airport, class, MHz) duplicates collapsed.
- Coordinates rounded to 4 decimals (~11 m — an airport is not a point),
  frequencies to 3 (the 25 kHz / 8.33 kHz channel grid).
- Columnar layout (`[ident, name, lat, lon, [[typeIndex, mhz], …]]`): the same
  data as an array of objects is ~2.4× larger, because every record would
  repeat its keys.
- Result: 14.0 MB source → 0.66 MB pack (budget ≤1 MB, enforced by
  `src/data/ourAirportsAtc.test.mjs`).

## The numbers that decide what the UI may promise

`type` in `airport-frequencies.csv` is **not** a flight phase, and a
phase→frequency map is not something this data can support everywhere:

| | airports in the pack |
|---|---|
| publish **all four** of TWR + GND + APP + ATIS | **443** |
| publish at least one of TWR / GND / APP / ATIS | 3,526 |
| publish none of those four — advisory only (CTAF/UNIC/AFIS) | **5,902** |
| publish none of those four and no advisory either — an area Center only | 134 |

So for the majority of airports in this pack there is no tower to hear, and the
truthful presentation is "uncontrolled field — CTAF 122.800, pilots
self-announce". `isControlled()` exists so a caller can say that instead of
rendering an empty tower row.

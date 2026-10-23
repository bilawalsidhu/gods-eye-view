- Bundle a curated **OurAirports ATC frequency pack**
  (`src/data/local_data/ourairports_atc/`, 9,562 airports · 16,509 frequencies,
  0.71 MB, public domain, no key) with an offline lookup in
  `src/data/ourAirportsAtc.js` — nearest airports to a position, their published
  frequency classes, and whether anyone is actually controlling them. The
  frequency class is carried through verbatim rather than remapped onto a flight
  phase: only 443 airports publish all four of TWR/GND/APP/ATIS and 5,902
  publish none of them, so "uncontrolled field — CTAF" is the majority answer
  and the data has to be able to say it. Rebuild with
  `node scripts/build-atc-frequencies.mjs`. Nothing reads the pack yet; the ATC
  decision layer (#723) is its first consumer (daikaginza, #719).

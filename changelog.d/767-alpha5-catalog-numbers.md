- Read satellite catalog numbers written in Alpha-5, the TLE spelling of
  numbers above 99999: a letter for the first two digits, skipping I and O
  (`A0000` is 100000, `Z9999` is 339999). The satellites layer converted such a
  field to `NaN`, so every Alpha-5 satellite shared one catalog entry and all
  but the first were dropped as duplicates; the satellite tools read the same
  field as no number, so such a satellite could not be found by it. The layer
  and the tools now decode the field in `src/sources/tle.js`, and reject a
  malformed one (a sign, decimal point, hex, embedded space or stray letter)
  instead of reading part of it as a number. This is Alpha-5 TLE
  compatibility: CelesTrak's TLE feed carries no satellite above 99999, which
  needs the OMM feed (#1191) (Honorius Neogy, #767, fixes #751).

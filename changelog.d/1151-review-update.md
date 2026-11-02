- Existing area annotations can outline Argentine departments, partidos and
  comunas using a lazy IGN pack of 529 units. Province qualifiers and camera
  location disambiguate names; source attribution and reuse terms are retained.
  (radianx, #1151).

- Analyst region queries retain IGN provenance and attribution after the
  region-resolution update. Same-named departments use a province, camera or
  geocoded anchor; cancelled deferred outlines cannot return stale geometry.
  Full province names containing commas are accepted without changing the pack.
  (radianx, #1151).

- Administrative-outline QA uses the native GPU with `--headful`, retains
  SwiftShader for Linux headless runs, and records redacted error URLs.
  (radianx, #1151).

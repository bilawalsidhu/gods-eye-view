- Add source-backed voice outlines without public Overpass calls: bundled Census and
  Who's On First boundaries cover places and neighborhoods, OpenFreeMap tiles
  cover streets, buildings, and grounds, and guarded Nominatim lookup handles
  remaining named areas with bounded caching and usage limits (Bilawal Sidhu,
  #842).
- Preserve standalone server-token maps, project tile outlines only on demand,
  select building components with their holes independently, preserve non-Latin
  street-name marks, and enforce public Nominatim spacing at fetch invocation.
  Nominatim now requires explicit endpoint configuration (Manjunath, #842).
- Keep Census labels in filled geometry, handle local dateline outlines in one
  coordinate frame, and require whole settlement names or explicit returned
  aliases while retaining landmark shorthand (Manjunath, #842).
- Harden and integrate voice outlines with main, and exclude the 90 Ottawa and
  Saskatoon source records whose redistribution terms remain unverified for
  this derived pack (Manjunath, #842).
- Wait for the original building installation before reporting duplicate results,
  including deferred outline installs, without restarting probes or changing
  timeout behavior (Manjunath, #842).
- Carry actual outline provenance to visible geometry and retain inline map credits only while the owning outline is displayed (Manjunath, #842).
- Require a named building's resolved anchor inside its tile footprint, outside
  courtyard holes, while keeping nearby selection for pointed-at buildings
  (Manjunath, #842).

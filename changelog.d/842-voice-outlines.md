- Add source-backed voice outlines without public Overpass calls: bundled Census and
  Who's On First boundaries cover places and neighborhoods, OpenFreeMap tiles
  cover streets, buildings, and grounds, and guarded Nominatim lookup handles
  remaining named areas with bounded caching and usage limits (bilawalsidhu,
  #842).
- Preserve standalone server-token maps, project tile outlines only on demand,
  select building components with their holes independently, preserve non-Latin
  street-name marks, and enforce public Nominatim spacing at fetch invocation.
  Nominatim now requires explicit endpoint configuration (manjunath22466, #842).
- Keep Census labels in filled geometry, handle local dateline outlines in one
  coordinate frame, and require whole settlement names or explicit returned
  aliases while retaining landmark shorthand (manjunath22466, #842).
- Harden and integrate voice outlines with main (manjunath22466, #842).
- Wait for the original building installation before reporting duplicate results,
  including deferred outline installs, without restarting probes
  (manjunath22466, #842).
- Carry actual outline provenance to visible geometry and retain inline map
  credits only while the owning outline is displayed (manjunath22466, #842).
- Require a named building's resolved anchor inside its tile footprint, outside
  courtyard holes, while keeping nearby selection for pointed-at buildings
  (manjunath22466, #842).
- Start each queued building's ground-sampling budget when it reaches the head
  of the queue, keep Nominatim outlines that cross the antimeridian, let an
  unnamed school, university, hospital, cemetery, stadium or zoo area answer a
  grounds ask whose head noun names that kind, keep the shared OpenFreeMap tile
  caches within the 64 MiB budget of the single source traffic and installations
  shared before, fold place names in one shared helper, and exclude Who's On
  First sources whose licence is only listed as CC BY or CC0 "equivalent",
  including the Ottawa, Saskatoon, Gatineau and Madrid records
  (manjunath22466, #842).
- Skip Nominatim place and outline lookups when the server reports that no
  Nominatim endpoint is configured, so a default install sends no request it
  would refuse (manjunath22466, #842).
- Keep the phone credit line on screen when map and outline credits make it
  longer, wrapping it within the screen instead of running off the edge
  (manjunath22466, #842).
- Outline nothing from tiles when the tile under the point failed to load, so a
  neighbouring building or area never stands in for it, and match each of a
  Nominatim name tag's ";"-separated names (manjunath22466, #842).

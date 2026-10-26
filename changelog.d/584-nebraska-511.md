- Add Nebraska 511 (NDOT) highway cameras as an opt-in CCTV source pack: one
  keyless POST to the 511 site's GraphQL backend, read under a byte cap with
  redirects refused, and frames pinned to NDOT's image host with the
  cache-buster stripped. NDOT grants no reuse licence for its camera images
  (transportation purposes only, unless otherwise approved), so the pack stays
  off unless `CCTV_NE511_ENABLED=1`. Anchors follow the I-80 corridor so a
  lowered `CCTV_NE511_MAX_SOURCES` thins to statewide coverage, and road-aligned
  headings come from a precomputed OSM table keyed by camera position, so they
  survive NDOT renumbering its cameras (NebraskaCoder, #584).
- Add an agency-agnostic `message-signs` layer that renders live electronic
  message signs as readable board faces turned toward the traffic each sign
  addresses, with Nebraska 511 (NDOT) as the first pack, opt-in with
  `SIGNS_NE511_ENABLED=1` under the same terms. The sign list and the sign-face
  images are served from the app origin, since the upstream CORS preflight is
  answered by its SPA host as HTML, and with no pack enabled the layer says so
  instead of showing an empty board (NebraskaCoder, #584).

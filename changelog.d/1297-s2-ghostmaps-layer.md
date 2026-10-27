- Add the S2 GhostMaps layer: S2 Underground's public KMZ intel products
  (Common Intelligence Picture, 30-day kinetic pull, Border Crisis Map, Iran
  and Yemen products and the newest incident drop) from
  github.com/s2underground/GhostMaps, with one chip per product and report
  cards on click. `/api/ghostmaps` watches the repository's branch head every
  15 s and pushes each new commit to open pages, which reload only the
  products that changed (Black Pine Defense).
- Clear a temporary GhostMaps upstream error and notify open pages when the
  repository becomes reachable again, including when no new edition was published.
- Release packed-image resources when a load is cancelled or fails, respect
  injected or omitted GhostMaps sources, and wait for background cache warm-up
  before removing provider test fixtures.
- Include Simplified Chinese translations and keep the combined voice prompt
  within its existing size limit while retaining all spoken aliases.

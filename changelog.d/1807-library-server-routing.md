- The Data Library's proxy is a fetch handler any server can mount
  (`createLibraryHandler`, `sources/library`). A server can hide catalog
  entries or route browser-direct ones through its proxy, view-bounded entries
  ask it for a grid-snapped box, answers are cacheable for `cacheSeconds`, and
  an application can fetch library tiles and datasets through its own cache
  (`createApplicationTools({ library })`) and offer only what the server's
  catalog names, nothing while it does not answer (`requireCatalog`). Tile
  paths and view boxes have one spelling, and partitioned reads can be capped
  per process and per request (samehkhamis, #1807).

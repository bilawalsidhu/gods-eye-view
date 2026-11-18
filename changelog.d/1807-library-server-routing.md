- The Data Library's proxy is a fetch handler any server can mount
  (`createLibraryHandler`, `sources/library`). A server can hide catalog
  entries or route browser-direct ones through its proxy, view-bounded entries
  ask it for a grid-snapped box, answers are cacheable for `cacheSeconds`, and
  an application can fetch library tiles and datasets through its own cache
  (`createApplicationTools({ library })`) (samehkhamis, #1807).

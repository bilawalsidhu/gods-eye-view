- Read terrain heights through one shared, cached and budgeted reader
  (`src/services/terrainSurface.js`) in Transit, Rail, Bike Share and the local
  data layers. Opening Data Centers no longer blocks the page for over two
  seconds, opening Bike Share for most of a second, and Rail asks the terrain
  about a twentieth as often (mazy1998).

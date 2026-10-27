- The terrain-heights bounds tests no longer read the checkout's
  `.gev-cache/terrain-heights.json`. Each test gets a cache file of its own, so
  `npm test` no longer fails after the dev server has cached terrain near
  Austin (KnottyDyes, #1244).

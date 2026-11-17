- Move the tile budget helpers `utcDayKey`, `normalizeBudget` and
  `isOverBudget` out of the TomTom module into `src/data/tileBudget.js`, so
  other keyed tile proxies can share them. `src/data/tomtomTiles.js`
  re-exports them; behaviour does not change (monwiss, #762).

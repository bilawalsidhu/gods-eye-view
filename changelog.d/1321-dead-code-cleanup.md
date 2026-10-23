- Remove dead code across the repository: three modules nothing imports
  (`src/ui.js`, `src/standalone/ui.js`, `src/data/localLayers.js`), exports
  and locals nothing reads, a duplicate copy of the bundled dams data and an
  unused ship model. The app no longer builds an unused default wind layer
  and Bhote Koshi locator layer when it loads. Package exports are unchanged
  (samehkhamis, #1321).

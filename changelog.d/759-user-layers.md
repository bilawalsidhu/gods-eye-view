- Add user layers: drop a `<name>.layer.js` module in `src/userLayers/` and it
  is discovered at build time, with no edit to any tracked file. Local layers
  are gitignored, so they never appear in a diff and never conflict on an
  upstream sync. They are addressed by id in a new `ul` share-link field rather
  than by the one-character token built-in layers use, so a locally added layer
  cannot compete for the 36 shared token slots or collide with whatever
  upstream assigns next. An unknown id in `ul` is skipped so a link from an
  install with different layers still restores its built-in half, while an
  unknown token in `l` still fails the payload closed. A layer whose
  `createLayer()` throws is logged and left out instead of stopping the
  application from starting. Documented in
  `docs/USER-LAYERS.md` (KnottyDyes, #759).

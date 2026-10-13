# Police Scanner layer

Layer id `police-scanner` (share-link token `3`). Toggle it in the layer panel
under Utilities, or say "police radio" / "scanner" to the voice agent.

## Add feeds
Edit `config/scanner-feeds.json` (see `config/scanner-feeds.example.json`).
The file is re-read on every request, so no restart is needed; click the layer
off/on to refresh.

- `type: "stream"`: a live HTTP(S) audio stream (Icecast/MP3/AAC), proxied
  through the dev server so URLs/credentials never reach the browser. Set
  `"allowPrivate": true` for a LAN source (e.g. your own SDR/rdio-scanner box).
- `type: "openmhz"`: latest recorded calls for an OpenMHz `system` (optional
  `talkgroup`). OpenMHz has no official API contract; this adapter is
  best-effort and untested against the live service.

Use only feeds you are allowed to use. Many agencies encrypt their traffic, and
some providers (e.g. Broadcastify) restrict redistribution.

## Files
- `server/providers/scanner.js`: `/api/scanner/{feeds,stream/:id,calls/:id}`
- `src/layers/scanner/`: model, source, layer (markers, panel, audio)
- wiring: constructCatalog, sourceComposition, standalone/layerSources,
  layerState (+ token ledger), layerPanel, voice layerManifest,
  package.json exports, scripts/package-boundaries.json

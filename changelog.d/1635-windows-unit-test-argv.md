- Fix `npm test` on Windows dying with `spawnSync ENAMETOOLONG` before any test
  ran: the unit runner's single `node --test` spawn carried all ~950 parallel
  test paths (~33.8k characters, over Windows' 32,767-character command-line
  limit). The runner now batches the parallel paths so every spawned command
  line stays under a 24,000-character budget, with the batching contract pinned
  against the real suite and a synthetic oversized suite (hakarrr, #1635).

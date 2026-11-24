- `npm test` runs on Windows again. The unit-test runner splits the parallel
  test paths into batches whose command line stays under Windows'
  32,767-character limit, instead of one `node --test` spawn that stopped with
  `ENAMETOOLONG` before any test ran (hakarrr, @hakarrr, #1920). Closes #1631.

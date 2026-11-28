- Let `npm test` run on Windows. The unit runner passed every test path to one
  process, a command line past Windows' 32,767-character limit, so it stopped
  with `ENAMETOOLONG` before any test ran. On Windows it now runs the suite in
  ordered batches that fit; other platforms keep a single run (Tricky454,
  #1980).

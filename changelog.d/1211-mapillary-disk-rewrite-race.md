- Rewrite an untrimmed Street Level disk tile once even when a concurrent read
  resolves after the first rewrite has finished. Such a hit used to rewrite the
  tile a second time, which also made `mapillaryProvider.test.mjs` fail
  intermittently on slow CI runners (daikaginza, #1211).

// T3 (breaker minor): `npm test` discovers *.test.mjs under src/ only, so the
// clientKey / X-Forwarded-For tests next to the server module never ran in CI.
// Importing that file registers its node:test cases in this run, keeping one
// copy of them beside the code they cover.
import '../../server/providers/common/rate-limit.test.mjs';

# Experimental historical disaster evidence receipts

Status: downstream research only. Tracks upstream RFC #1198 and **does not**
implement an emergency response product. No app module imports this helper.

## Purpose and ownership

`src/data/disasterEvidenceReceipt.js` is a Cesium-free, network-free admission
and validity guard **around** a precomputed route-access evaluation. It does
not fetch data, construct routes, infer road conditions, decide whether a
bridge is safe, grant operational authority, or replace the access evaluator
being reviewed in draft PR #882. Source-owned observations and a trusted
route-segment mapper are prerequisites, not outputs of this module.

The intended initial consumer is a synthetic or historical exercise. `supported`
means only that the **precomputed evaluation is consistent with the supplied
explicit, direct observations under the supplied trust policy**. It does not
mean a real route is passable. No live provider or humanitarian agency has
validated this prototype. No field-use claims are authorized.

## Inputs

`createDisasterEvidenceReceipt({ ... })` accepts:

- `routeId` and `routeRevision`: a trusted candidate-route identity/revision.
- `accessRevision` and `policyRevision`: version identifiers assigned by the
  evidence and policy owners, not copied from an arbitrary feed's labels.
- `mapping`: `{ routeId, revision, complete, segmentIds }`. `complete: true`
  **must be attested by a trusted route-mapping owner**. This helper can check
  that listed segments are well formed and match the evaluator, but cannot
  prove that they cover the entire physical route. Never set `complete: true`
  just to make a test pass.
- `assessment`: `{ routeId, segmentIds, support }`, where `support` is one of
  `supported | degraded | unsupported | unknown`. A future consumer may adapt
  the corresponding fields of draft #882's evaluator; this branch does not
  import that draft or independently calculate road access.
- `trustedSources`: local application-owned policy keyed by a source ID, with
  `{ allowedDeterminations: ['observed' | 'declared'], maxAgeMs }`.
  **This is trust configuration, not an authentication mechanism.** External
  source records must never supply or modify this configuration. An operator
  still needs to verify source credentials, scope, and actual claims.
- `observations`: bounded explicit access records. Each contains stable `id`,
  `segmentId`, `sourceId`, `sourceRevision`, `claim` (`open | degraded | blocked`),
  `determination` (`observed | declared`), UTC `observedAt`, UTC `receivedAt`,
  optional UTC `validUntil`, and optional `scenarioId`. `scenarioId` records
  are excluded from factual support. Evidence with no valid source policy is
  also excluded.
- `asOfMs`: caller-controlled historical assessment instant in epoch
  milliseconds. Use an independently trusted clock/selected replay instant.

Both UTC timestamps and the source's maximum evidence age are checked.
`receivedAt` cannot precede `observedAt`, and no record may be received after
`asOfMs`. Expired records, invalid dates, missing segments, contradictions,
unsupported identities, and divergent assessments downgrade the receipt to
`unknown`. There is no fallback from missing evidence to `open`.

## Outputs

The helper returns a frozen receipt with `support`, sorted `reasonCodes`,
version identifiers, `assessedAt`, frozen minimal `evidenceRefs`, and a
`receipt-v1:...` identity for reproducibility. The `fingerprint` is **FNV-1a
64**, a non-cryptographic change detector; it is not a signature and must
never be used to authenticate evidence, satisfy a regulatory integrity
requirement, or authorize dispatch. Untrusted users can forge or collide it.
The receipt omits detailed coordinates, personal records, and raw media.

`isDisasterEvidenceReceiptCurrent(receipt, inputsWithUpdatedAsOfMs)`
recomputes the admission gate and checks fingerprint, revisions, effective
support, and reason codes. It can reject content or policy changes even when
an external revision ID was accidentally not incremented. It also rejects
expired data. Any downstream action must independently revalidate the source
and mapping owners; `isCurrent` is not a permission check.

## Example: wholly synthetic data

```js
const assessment = {
  routeId: 'exercise-route',
  segmentIds: ['road-a', 'bridge-b'],
  support: 'supported', // supplied by the external evaluator
};

const receipt = createDisasterEvidenceReceipt({
  routeId: 'exercise-route',
  routeRevision: 'route-r1',
  accessRevision: 'access-r1',
  policyRevision: 'policy-r1',
  mapping: {
    routeId: 'exercise-route',
    revision: 'mapping-r1',
    complete: true, // exercise-only, explicit full coverage assertion
    segmentIds: ['road-a', 'bridge-b'],
  },
  assessment,
  trustedSources: {
    fixture: { allowedDeterminations: ['declared'], maxAgeMs: 30 * 60_000 },
  },
  observations: [
    {
      id: 'e1', segmentId: 'road-a', sourceId: 'fixture',
      sourceRevision: 'r1', claim: 'open', determination: 'declared',
      observedAt: '2026-08-26T09:10:00Z',
      receivedAt: '2026-08-26T09:11:00Z',
    },
    {
      id: 'e2', segmentId: 'bridge-b', sourceId: 'fixture',
      sourceRevision: 'r1', claim: 'open', determination: 'declared',
      observedAt: '2026-08-26T09:10:00Z',
      receivedAt: '2026-08-26T09:11:00Z',
    },
  ],
  asOfMs: Date.parse('2026-08-26T09:20:00Z'),
});
```

A real caller must replace all exercise assertions with verified facts from
separate owners. The Bhote Koshi historical event pack includes licensed imagery
and witness references, not confirmed road-access observations. Never infer
open/blocked status from the event pack's imagery, witness titles, or schematic
flood progression.

## Non-goals and explicit blockers

- No source authentication, rights clearance, or remote data integration.
- No independent route-to-segment geometry proof. The trusted mapper remains
  a prerequisite. Even a `supported` receipt can be wrong if `complete` is
  improperly attested.
- No conflict adjudication or stale-data override. Conflicting claims fail to
  `unknown` rather than being decided by input ordering.
- No PDF/export, scene UI, browser wiring, database, new API, agent action,
  provider calls, or source redistribution.
- No operational road-safety, crisis dispatch, beneficiary, or relief
  allocation authority. The only acceptable first use is a bounded exercise.

## Verification

Focused deterministic test suite:

```bash
node --test src/data/disasterEvidenceReceipt.test.mjs
```

For upstream contribution, also run `npm run format:check`,
`npm run check:boundaries`, `npm run i18n`, `npm run changelog:check`,
`npm test`, `npm run build`, and applicable browser/track regression gates on
exact-head Node 24.14/26. The tests in this research branch do not establish
full application or field readiness.

## Promotion gate

Before integrating this helper or proposing an upstream PR, obtain explicit
maintainer direction on #1198, resolve interface ownership with draft #882 and
the downstream Directions adapter, and demonstrate end-to-end source-policy,
route-coverage, simulation-isolation, data-rights, and user comprehension.

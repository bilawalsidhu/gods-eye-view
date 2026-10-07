# Demon Forge: privacy exposure case management

**Status:** Design approved for implementation planning  
**Scope:** France/EU first; other jurisdictions are future, isolated policy packs.

## Purpose

Demon Forge is an opt-in, local-first workspace inside God's Eye View for
people who want to audit and reduce their own public online exposure, or for
operators acting for a relative or client under a signed, explicit mandate.

It is a privacy-protection case-management tool. It does not identify,
locate, profile, or investigate people without authorization. It is not an
intelligence layer and does not render personal exposure records on the globe.

## Goals

- Create one protected-person case at a time.
- Require a valid signed mandate for every non-self case.
- Import a user-selected, local Social Analyzer report after schema validation
  and data minimization.
- Support a human review of potential public exposures before any request is
  drafted.
- Prepare evidence-backed, jurisdiction-specific deletion, correction,
  objection, or de-indexing request drafts.
- Track approvals, proof of sending, responses, and review dates locally.

## Non-goals

- No searching or actions for an unconsenting third party.
- No automatic profile correlation, identity determination, or bulk discovery.
- No automated submission of deletion requests in V1.
- No claim that a request guarantees deletion, closure, de-indexing, or legal
  compliance.
- No bundled or copied Social Analyzer code.
- No public export, globe placement, or live collaboration for case data.

## Product boundaries

God's Eye View remains MIT licensed. Social Analyzer is AGPL-3.0 and is kept
as a separately installed, locally executed tool. Demon Forge accepts only an
explicitly chosen report file; it never invokes, bundles, or communicates with
Social Analyzer.

The existing Inconito application is a UX reference for broker-removal flows.
Its mock server and broker catalog are not operational sources of truth. A
future source directory must be maintained with provenance, jurisdiction,
last-verification date, and a human confirmation before use.

## Case and authorization model

Each case contains a protected person, a case owner, and a scope:

- **Self case:** the case owner is the protected person.
- **Mandated case:** the case stores a signed mandate, validity dates,
  authorized identifiers, allowed source categories, and permitted actions.

The policy guard blocks importing, reviewing, drafting, exporting, or sending
evidence when a required authorization is missing, expired, revoked, or out of
scope. It never silently downgrades a blocked action.

## Data model

All case records stay local and encrypted at rest. A record has only the data
needed for its purpose:

| Record | Minimum data |
| --- | --- |
| Case | opaque ID, local title, owner, protected-person role, status |
| Mandate | encrypted document, scope, issue/expiry/revocation dates, validation state |
| Identifier | type, normalized value, authorization source, scope |
| Exposure candidate | source, URL, confidence, report timestamp, review state |
| Request draft | target controller, action type, selected data, rationale, rendered draft, approval state |
| Evidence | content hash, local encrypted attachment reference, capture time, operator |
| Ledger event | append-only timestamp, actor, action, outcome, reason |

Raw imported reports are discarded after validated candidates are derived,
unless the operator explicitly retains an encrypted original as evidence.

## Workflow

1. Create a self or mandated case.
2. Validate the case scope and mandate before enabling further stages.
3. An operator runs Social Analyzer outside Demon Forge and selects a report to
   import locally.
4. The importer validates structure, rejects unexpected fields, normalizes
   accepted candidates, and records source/time/confidence.
5. A human reviews every candidate. A match remains unverified until the
   operator records adequate evidence; ambiguous matches are not actionable.
6. The operator selects an appropriate action: deletion, correction,
   objection, account closure, or de-indexing.
7. Request Studio generates a clearly labelled draft. The case owner/operator
   performs the required approval(s).
8. V1 opens an official contact route or makes a copyable draft available;
   sending is manual. The operator records proof of sending.
9. The ledger tracks response and review dates, then prepares a human-reviewed
   follow-up or referral packet if appropriate.

State transitions are:

`draft -> awaiting review -> approved -> manually sent -> response/review -> closed`

Any missing mandate, unverified source, malformed import, ambiguous identity,
or missing approval prevents the next transition and gives a specific reason.

## Component architecture

| Component | Responsibility | Must not do |
| --- | --- | --- |
| Case Vault | encrypted local cases, mandates, retention | network discovery or request sending |
| Policy Guard | authorization, scope and state checks | infer consent or identity |
| Report Importer | validate/minimize an imported report | run Social Analyzer or enrich profiles |
| Exposure Review | human candidate triage and evidence capture | auto-confirm a match |
| Request Studio | create transparent drafts and approval record | submit requests automatically |
| Evidence Ledger | append-only local timeline and deadline tracking | expose records to the globe/UI layers |
| Source Directory | verified controller/contact metadata | treat stale entries as authoritative |

Demon Forge is disabled by default. It has no independent network client and
does not share data with existing live-data layers or analytics/logging.

## Privacy, security, and safety controls

- Encrypt case material and attachments locally; avoid personal data in logs.
- Use short retention defaults and a deliberate, auditable case-deletion flow.
- Require session lock and explicit export confirmation; exports are encrypted.
- Do not retain identity documents unless a user explicitly chooses to attach
  them as evidence.
- Show uncertainty on every candidate and prohibit action on collision-prone
  identifiers alone.
- Separate deletion, account closure, removal of a post, de-indexing, and
  objection in the interface and request text.
- Use local fixture data only in automated tests.
- Treat legal templates as editable operational drafts, not legal advice.

## France/EU policy pack

The first policy pack supports a guided exercise of data-subject requests. It
must state the requested action, relevant data, controller/contact, rationale,
evidence, and follow-up date. It must surface that rights can be limited and
that a request does not necessarily remove a whole account or every retained
record. It must preserve a copy of the request and proof of sending.

Policy content will be separately reviewed against current official guidance
before release; it is not a substitute for legal advice.

## Failure handling

| Condition | Required behavior |
| --- | --- |
| Expired/revoked/missing mandate | block action and explain which condition failed |
| Import malformed or unexpected | reject atomically; persist no partial candidates |
| Candidate ambiguous | retain as unverified; drafting is disabled |
| Source contact stale/unverified | show review-required; do not produce a send-ready route |
| Required approval absent | prevent transition to approved/sent |
| Local decryption failure | lock the case; do not fall back to plaintext |
| User cancels case deletion | leave records untouched |

## Verification plan

- Unit tests for policy checks, scope expiry, state transitions, normalization,
  import rejection, encryption boundaries, and ledger append rules.
- End-to-end tests with synthetic mandates, people, reports, requests, and
  response evidence only.
- Negative tests: unauthorized third party, expired mandate, scope overreach,
  modified import, profile collision, plaintext export, missing approval, and
  stale source directory entry.
- Privacy checks that inspect application logs, browser storage, imports, and
  exports for unintended personal-data disclosure.
- Manual UX review ensuring the workspace remains visually and semantically
  distinct from the globe's public-data intelligence layers.

## Implementation gates

1. Establish the encrypted local-storage and authorization primitives with
   fixtures and tests.
2. Add an import-only, fail-closed Social Analyzer adapter.
3. Add review, ledger, and draft-generation surfaces without sending.
4. Add the France/EU policy pack and source-directory review workflow.
5. Conduct a privacy/security review and run the repository's required build,
   unit-test, and tracking gates before any upstream contribution.

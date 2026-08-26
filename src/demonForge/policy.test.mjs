import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CASE_KIND,
  CANDIDATE_STATUS,
  REQUEST_STATUS,
  createCaseRecord,
} from './types.js';
import {
  canCreateRequest,
  evaluateCaseAuthorization,
  transitionRequest,
} from './policy.js';

test('expired mandated cases are rejected', () => {
  const nowMs = 1_700_000_000_000;
  const caseRecord = createCaseRecord({
    kind: CASE_KIND.NON_SELF,
    mandate: {
      expiresAtMs: nowMs - 1,
      sourceScopes: ['local'],
      proof: {
        signedAtMs: nowMs - 2,
        validatedAtMs: nowMs - 1,
      },
    },
  });

  const result = evaluateCaseAuthorization(caseRecord, nowMs);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'mandate_expired');
  assert.match(result.message, /expired/i);
});

test('unconfirmed candidates and scope mismatches block draft creation', () => {
  const nowMs = 1_700_000_000_000;
  const caseRecord = createCaseRecord({
    kind: CASE_KIND.NON_SELF,
    mandate: {
      expiresAtMs: nowMs + 60_000,
      sourceScopes: ['local'],
      proof: {
        signedAtMs: nowMs - 2,
        validatedAtMs: nowMs - 1,
      },
    },
  });

  const unconfirmed = {
    status: CANDIDATE_STATUS.UNCONFIRMED,
    sourceScope: 'local',
  };
  const unconfirmedResult = canCreateRequest(caseRecord, unconfirmed, REQUEST_STATUS.DRAFT, nowMs);

  assert.equal(unconfirmedResult.ok, false);
  assert.equal(unconfirmedResult.code, 'candidate_unconfirmed');

  const outOfScope = {
    status: CANDIDATE_STATUS.CONFIRMED,
    confirmedAtMs: nowMs - 1,
    sourceScope: 'external',
  };
  const outOfScopeResult = canCreateRequest(caseRecord, outOfScope, REQUEST_STATUS.DRAFT, nowMs);

  assert.equal(outOfScopeResult.ok, false);
  assert.equal(outOfScopeResult.code, 'source_scope_mismatch');
});

test('self and non-self case kinds stay explicit and non-self mandates need proof', () => {
  const nowMs = 1_700_000_000_000;
  const selfCase = createCaseRecord({ kind: CASE_KIND.SELF });
  const nonSelfCase = createCaseRecord({
    kind: CASE_KIND.NON_SELF,
    mandate: {
      expiresAtMs: nowMs + 60_000,
      sourceScopes: ['local'],
      proof: {
        signedAtMs: nowMs - 2,
        validatedAtMs: nowMs - 1,
      },
    },
  });

  assert.equal(selfCase.kind, CASE_KIND.SELF);
  assert.equal(nonSelfCase.kind, CASE_KIND.NON_SELF);
  assert.equal(nonSelfCase.mandate.sourceScopes[0], 'local');

  const missingMandate = createCaseRecord({ kind: CASE_KIND.NON_SELF });
  const missingResult = evaluateCaseAuthorization(missingMandate, nowMs);
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.code, 'mandate_missing');

  const unsignedCase = createCaseRecord({
    kind: CASE_KIND.NON_SELF,
    mandate: {
      expiresAtMs: nowMs + 60_000,
      sourceScopes: ['local'],
      proof: {
        validatedAtMs: nowMs - 1,
      },
    },
  });
  const unsignedResult = evaluateCaseAuthorization(unsignedCase, nowMs);
  assert.equal(unsignedResult.ok, false);
  assert.equal(unsignedResult.code, 'mandate_unverified');

  const rejectedCandidate = {
    status: CANDIDATE_STATUS.REJECTED,
    confirmedAtMs: nowMs - 1,
    sourceScope: 'local',
  };
  const rejectedResult = canCreateRequest(nonSelfCase, rejectedCandidate, REQUEST_STATUS.DRAFT, nowMs);
  assert.equal(rejectedResult.ok, false);
  assert.equal(rejectedResult.code, 'candidate_unconfirmed');
});

test('sent transitions stay fail-closed in V1', () => {
  const request = {
    status: REQUEST_STATUS.DRAFT,
  };

  const missingApproval = transitionRequest(request, REQUEST_STATUS.SENT, null, 1_700_000_000_000);
  assert.equal(missingApproval.ok, false);
  assert.equal(missingApproval.code, 'approval_required');

  const explicitSend = transitionRequest(
    request,
    REQUEST_STATUS.SENT,
    { approvedBy: 'lead-reviewer' },
    1_700_000_000_000,
  );
  assert.equal(explicitSend.ok, false);
  assert.equal(explicitSend.code, 'send_disabled');
});

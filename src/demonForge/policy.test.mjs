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
    kind: CASE_KIND.MANDATED,
    mandate: {
      expiresAtMs: nowMs - 1,
      sourceScope: 'local',
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
    kind: CASE_KIND.MANDATED,
    mandate: {
      expiresAtMs: nowMs + 60_000,
      sourceScope: 'local',
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

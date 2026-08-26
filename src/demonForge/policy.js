import {
  CASE_KIND,
  CANDIDATE_STATUS,
  REQUEST_STATUS,
} from './types.js';

function decision(ok, code, message) {
  return { ok, code, message };
}

function reject(code, message) {
  return decision(false, code, message);
}

function accept(code, message) {
  return decision(true, code, message);
}

function isConfirmedCandidate(candidate) {
  return (
    candidate?.status === CANDIDATE_STATUS.CONFIRMED ||
    candidate?.confirmedAtMs != null
  );
}

export function evaluateCaseAuthorization(caseRecord, nowMs) {
  const mandate = caseRecord?.mandate || {};

  if (
    caseRecord?.kind === CASE_KIND.MANDATED &&
    mandate.expiresAtMs != null &&
    nowMs > mandate.expiresAtMs
  ) {
    return reject('mandate_expired', 'Mandated case expired.');
  }

  return accept('case_authorized', 'Case is authorized.');
}

export function canCreateRequest(caseRecord, candidate, action, nowMs) {
  const authorization = evaluateCaseAuthorization(caseRecord, nowMs);
  if (!authorization.ok) return authorization;

  if (action !== REQUEST_STATUS.DRAFT) {
    return reject('unsupported_action', 'Only draft creation is allowed.');
  }

  if (!candidate) {
    return reject('candidate_missing', 'A candidate is required.');
  }

  if (!isConfirmedCandidate(candidate)) {
    return reject('candidate_unconfirmed', 'Candidate confirmation is required.');
  }

  const mandateScope = caseRecord?.mandate?.sourceScope ?? null;
  const candidateScope = candidate.sourceScope ?? null;

  if (mandateScope && candidateScope !== mandateScope) {
    return reject('source_scope_mismatch', 'Candidate source scope is out of bounds.');
  }

  if (mandateScope && !candidateScope) {
    return reject('source_scope_missing', 'Candidate source scope is required.');
  }

  return accept('request_allowed', 'Draft request is allowed.');
}

export function transitionRequest(request, nextStatus, approval, nowMs) {
  void request;
  void nowMs;

  if (nextStatus === REQUEST_STATUS.SENT && !approval) {
    return reject('approval_required', 'Approval is required before send.');
  }

  if (nextStatus === REQUEST_STATUS.SENT) {
    return reject('send_disabled', 'V1 never sends requests automatically.');
  }

  if (!approval) {
    return reject('approval_required', 'Approval is required.');
  }

  return accept('transition_allowed', 'Request transition is allowed.');
}

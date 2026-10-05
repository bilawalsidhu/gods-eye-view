import { CASE_KIND, CANDIDATE_STATUS, REQUEST_STATUS } from './types.js';

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
  return candidate?.status === CANDIDATE_STATUS.CONFIRMED;
}

export function evaluateCaseAuthorization(caseRecord, nowMs) {
  if (
    caseRecord?.kind !== CASE_KIND.SELF &&
    caseRecord?.kind !== CASE_KIND.NON_SELF
  ) {
    return reject('case_kind_required', 'Case kind must be explicit.');
  }

  if (caseRecord.kind === CASE_KIND.SELF) {
    return accept('case_authorized', 'Self case is authorized.');
  }

  const mandate = caseRecord?.mandate;
  const sourceCategories = Array.isArray(mandate?.sourceCategories)
    ? mandate.sourceCategories
    : [];
  const permittedActions = Array.isArray(mandate?.permittedActions)
    ? mandate.permittedActions
    : [];
  const proof = mandate?.proof || {};

  if (!mandate) {
    return reject('mandate_missing', 'Non-self cases require a mandate.');
  }

  if (proof.signedAtMs == null || proof.validatedAtMs == null) {
    return reject(
      'mandate_unverified',
      'Mandate must be signed and validated.',
    );
  }

  if (mandate.revokedAtMs != null && nowMs >= mandate.revokedAtMs) {
    return reject('mandate_revoked', 'The signed mandate has been revoked.');
  }

  if (sourceCategories.length === 0) {
    return reject(
      'mandate_scope_missing',
      'Mandate source categories are required.',
    );
  }

  if (permittedActions.length === 0) {
    return reject(
      'mandate_action_missing',
      'Mandate permitted actions are required.',
    );
  }

  if (mandate.expiresAtMs == null || nowMs >= mandate.expiresAtMs) {
    return reject(
      'mandate_expired',
      'Non-self case mandate has expired or has no expiry.',
    );
  }

  return accept('case_authorized', 'Non-self case is authorized.');
}

export function canCreateRequest(caseRecord, candidate, action, nowMs) {
  const authorization = evaluateCaseAuthorization(caseRecord, nowMs);
  if (!authorization.ok) return authorization;

  if (typeof action !== 'string' || !action.trim()) {
    return reject('unsupported_action', 'A request action is required.');
  }

  if (!candidate) {
    return reject('candidate_missing', 'A candidate is required.');
  }

  if (
    candidate.status !== CANDIDATE_STATUS.CONFIRMED ||
    !isConfirmedCandidate(candidate)
  ) {
    return reject(
      'candidate_unconfirmed',
      'Candidate confirmation is required.',
    );
  }

  const mandateCategories = Array.isArray(caseRecord?.mandate?.sourceCategories)
    ? caseRecord.mandate.sourceCategories
    : [];
  const permittedActions = Array.isArray(caseRecord?.mandate?.permittedActions)
    ? caseRecord.mandate.permittedActions
    : [];
  const candidateCategory = candidate.sourceCategory ?? null;

  if (caseRecord?.kind === CASE_KIND.NON_SELF && !candidateCategory) {
    return reject(
      'source_scope_missing',
      'Candidate source category is required.',
    );
  }

  if (
    caseRecord?.kind === CASE_KIND.NON_SELF &&
    !mandateCategories.includes(candidateCategory)
  ) {
    return reject(
      'source_scope_mismatch',
      'Candidate source category is out of bounds.',
    );
  }

  if (
    caseRecord?.kind === CASE_KIND.NON_SELF &&
    !permittedActions.includes(action)
  ) {
    return reject(
      'action_scope_mismatch',
      'The selected action is outside the signed mandate.',
    );
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

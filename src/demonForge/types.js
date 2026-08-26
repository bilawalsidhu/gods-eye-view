export const CASE_KIND = Object.freeze({
  SELF: 'self',
  NON_SELF: 'non_self',
});

export const CANDIDATE_STATUS = Object.freeze({
  UNCONFIRMED: 'unconfirmed',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
});

export const REQUEST_STATUS = Object.freeze({
  DRAFT: 'draft',
  REVIEW: 'review',
  SENT: 'sent',
  ARCHIVED: 'archived',
});

export function createCaseRecord(input = {}) {
  const mandate = input.mandate || {};
  const candidate = input.candidate || {};
  const sourceScopes = Array.isArray(mandate.sourceScopes)
    ? mandate.sourceScopes.filter((sourceScope) => typeof sourceScope === 'string' && sourceScope.trim())
    : [];

  return {
    kind: input.kind === CASE_KIND.NON_SELF ? CASE_KIND.NON_SELF : CASE_KIND.SELF,
    mandate: {
      sourceScopes,
      expiresAtMs: mandate.expiresAtMs ?? input.expiresAtMs ?? null,
      proof: {
        signedAtMs: mandate.proof?.signedAtMs ?? mandate.signedAtMs ?? null,
        validatedAtMs: mandate.proof?.validatedAtMs ?? mandate.validatedAtMs ?? null,
      },
    },
    candidate: {
      status: candidate.status || CANDIDATE_STATUS.UNCONFIRMED,
      sourceScope: candidate.sourceScope ?? null,
      confirmedAtMs: candidate.confirmedAtMs ?? null,
    },
    requests: Array.isArray(input.requests) ? [...input.requests] : [],
  };
}

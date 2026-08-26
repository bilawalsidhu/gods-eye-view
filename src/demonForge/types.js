export const CASE_KIND = Object.freeze({
  MANDATED: 'mandated',
  OPTIONAL: 'optional',
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

  return {
    kind: input.kind || CASE_KIND.OPTIONAL,
    mandate: {
      sourceScope: mandate.sourceScope ?? input.sourceScope ?? null,
      expiresAtMs: mandate.expiresAtMs ?? input.expiresAtMs ?? null,
      confirmedAtMs: mandate.confirmedAtMs ?? null,
    },
    candidate: {
      status: candidate.status || CANDIDATE_STATUS.UNCONFIRMED,
      sourceScope: candidate.sourceScope ?? null,
      confirmedAtMs: candidate.confirmedAtMs ?? null,
    },
    requests: Array.isArray(input.requests) ? [...input.requests] : [],
  };
}

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

export const REQUEST_ACTION = Object.freeze({
  ERASURE: 'erasure',
  CORRECTION: 'correction',
  OBJECTION: 'objection',
  ACCOUNT_CLOSURE: 'account_closure',
  DEINDEXING: 'deindexing',
});

const REQUEST_ACTIONS = new Set(Object.values(REQUEST_ACTION));

function stringList(value, allowed = null) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .map((entry) => entry.trim())
        .filter((entry) => !allowed || allowed.has(entry)),
    ),
  ];
}

export function createCaseRecord(input = {}) {
  if (input.kind !== CASE_KIND.SELF && input.kind !== CASE_KIND.NON_SELF) {
    throw new TypeError('Case kind must be explicit.');
  }
  const mandate = input.mandate || {};
  const candidate = input.candidate || {};
  const sourceCategories = stringList(mandate.sourceCategories);
  const permittedActions = stringList(
    mandate.permittedActions,
    REQUEST_ACTIONS,
  );

  return {
    id: input.id ?? null,
    title: input.title ?? '',
    status: input.status ?? 'draft',
    kind: input.kind,
    mandate: {
      sourceCategories,
      permittedActions,
      expiresAtMs: mandate.expiresAtMs ?? input.expiresAtMs ?? null,
      revokedAtMs: mandate.revokedAtMs ?? null,
      proof: {
        signedAtMs: mandate.proof?.signedAtMs ?? mandate.signedAtMs ?? null,
        validatedAtMs:
          mandate.proof?.validatedAtMs ?? mandate.validatedAtMs ?? null,
      },
    },
    candidate: {
      status: candidate.status || CANDIDATE_STATUS.UNCONFIRMED,
      sourceCategory: candidate.sourceCategory ?? null,
      confirmedAtMs: candidate.confirmedAtMs ?? null,
    },
    candidates: Array.isArray(input.candidates)
      ? input.candidates.map((entry) => ({ ...entry }))
      : [],
    draft: input.draft ? { ...input.draft } : null,
    ledger: Array.isArray(input.ledger)
      ? input.ledger.map((entry) => ({ ...entry }))
      : [],
    workflow: Array.isArray(input.workflow)
      ? input.workflow.map((entry) => ({ ...entry }))
      : [],
    requests: Array.isArray(input.requests) ? [...input.requests] : [],
  };
}

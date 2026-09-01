import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASE_KIND, CANDIDATE_STATUS, createCaseRecord } from './types.js';
import { approveDraft, createFranceEuDraft } from './requestStudio.js';

const nowMs = 1_700_000_000_000;
const candidate = { status: CANDIDATE_STATUS.CONFIRMED, sourceScope: 'synthetic', url: 'https://example.test/profile' };

function validCase(expiresAtMs = nowMs + 1_000) {
  return createCaseRecord({
    kind: CASE_KIND.NON_SELF,
    mandate: { expiresAtMs, sourceScopes: ['synthetic'], proof: { signedAtMs: nowMs - 2, validatedAtMs: nowMs - 1 } },
  });
}

test('France/EU draft is manual, exact, and does not promise deletion', () => {
  const draft = createFranceEuDraft({ action: 'erasure', controllerName: 'Synthetic Controller', contactRoute: 'https://controller.test/privacy', candidate });

  assert.match(draft.body, /demande d'effacement/i);
  assert.match(draft.body, /https:\/\/example\.test\/profile/);
  assert.match(draft.body, /Synthetic Controller/);
  assert.match(draft.body, /revue manuelle/i);
  assert.match(draft.body, /brouillon/i);
  assert.doesNotMatch(draft.body, /promet la suppression complète/i);
  assert.equal('transport' in draft, false);
});

test('draft creation and approval require an exact candidate URL', () => {
  assert.throws(
    () => createFranceEuDraft({ action: 'erasure', controllerName: 'Synthetic Controller', contactRoute: 'https://controller.test/privacy', candidate: { ...candidate, url: ' ' } }),
    /candidate\.url is required/i,
  );

  const draft = createFranceEuDraft({ action: 'erasure', controllerName: 'Synthetic Controller', contactRoute: 'https://controller.test/privacy', candidate });
  draft.candidate.url = '';
  assert.equal(approveDraft(draft, { actor: 'case-owner' }, validCase(), nowMs).code, 'CANDIDATE_URL_REQUIRED');
});

test('approval fails closed for missing approval, expired mandates, and unconfirmed candidates', () => {
  const draft = createFranceEuDraft({ action: 'erasure', controllerName: 'Synthetic Controller', contactRoute: 'https://controller.test/privacy', candidate });
  assert.equal(approveDraft(draft, null, validCase(), nowMs).code, 'APPROVAL_REQUIRED');
  assert.equal(approveDraft(draft, { actor: 'owner' }, validCase(nowMs), nowMs).code, 'mandate_expired');

  const unconfirmedDraft = createFranceEuDraft({ ...draft, candidate: { ...candidate, status: CANDIDATE_STATUS.UNCONFIRMED } });
  assert.equal(approveDraft(unconfirmedDraft, { actor: 'owner' }, validCase(), nowMs).code, 'candidate_unconfirmed');
});

test('valid approval stores an actor, timestamp, and rendered body hash', () => {
  const draft = createFranceEuDraft({ action: 'correction', controllerName: 'Synthetic Controller', contactRoute: 'https://controller.test/privacy', candidate });
  const approved = approveDraft(draft, { actor: 'case-owner' }, validCase(), nowMs);

  assert.equal(approved.status, 'approved');
  assert.equal(approved.approval.actor, 'case-owner');
  assert.equal(approved.approval.approvedAtMs, nowMs);
  assert.match(approved.approval.renderedBodyHash, /^[a-f0-9]{64}$/u);
});

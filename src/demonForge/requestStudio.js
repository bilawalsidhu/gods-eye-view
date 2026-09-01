import { canCreateRequest } from './policy.js';
import { sha256Hex } from './ledger.js';

const ACTION_LABELS = Object.freeze({
  erasure: "demande d'effacement",
  correction: 'demande de rectification',
  objection: "demande d'opposition",
  account_closure: 'demande de fermeture de compte',
  deindexing: 'demande de déréférencement',
});

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function requireHttpsUrl(value) {
  const route = requireText(value, 'contactRoute');
  let url;
  try {
    url = new URL(route);
  } catch {
    throw new TypeError('contactRoute must be an HTTPS URL.');
  }
  if (url.protocol !== 'https:') throw new TypeError('contactRoute must be an HTTPS URL.');
  return url.href;
}

export function createFranceEuDraft(input = {}) {
  const action = requireText(input.action, 'action');
  const actionLabel = ACTION_LABELS[action] ?? `demande relative à l'action « ${action} »`;
  const controllerName = requireText(input.controllerName, 'controllerName');
  const contactRoute = requireHttpsUrl(input.contactRoute);
  const candidateUrl = input.candidate?.url ? String(input.candidate.url) : 'URL de l’élément concerné à compléter lors de la revue';
  const body = [
    'BROUILLON — à relire et à valider manuellement avant toute démarche.',
    '',
    `Objet : ${actionLabel}`,
    `Responsable du traitement : ${controllerName}`,
    `URL concernée : ${candidateUrl}`,
    `Voie de contact à utiliser après revue manuelle : ${contactRoute}`,
    '',
    `Je souhaite exercer une ${actionLabel} concernant l’URL indiquée ci-dessus. Merci d’examiner cette demande et de m’indiquer la suite donnée, ainsi que toute limite applicable à ce droit.`,
    'Ce texte est un brouillon opérationnel, pas un envoi automatique ni un avis juridique. Il ne promet pas la suppression complète des données, du compte ou de tous les enregistrements conservés.',
  ].join('\n');

  return {
    status: 'draft',
    action,
    controllerName,
    contactRoute,
    body,
    approval: null,
    candidate: input.candidate ? { ...input.candidate } : null,
  };
}

export function approveDraft(draft, approval, caseRecord, nowMs) {
  if (!draft || draft.status !== 'draft') return { ok: false, code: 'DRAFT_NOT_APPROVABLE', message: 'Only a draft can be approved.' };
  if (!approval || typeof approval.actor !== 'string' || !approval.actor.trim()) {
    return { ok: false, code: 'APPROVAL_REQUIRED', message: 'Approval requires an explicit actor.' };
  }
  if (!Number.isFinite(nowMs)) return { ok: false, code: 'APPROVAL_TIMESTAMP_REQUIRED', message: 'Approval requires an explicit timestamp.' };

  const authorization = canCreateRequest(caseRecord, draft.candidate, 'draft', nowMs);
  if (!authorization.ok) return authorization;

  return {
    ...draft,
    status: 'approved',
    approval: {
      actor: approval.actor.trim(),
      approvedAtMs: nowMs,
      renderedBodyHash: sha256Hex(draft.body),
    },
  };
}

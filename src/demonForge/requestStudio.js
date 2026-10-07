import { canCreateRequest } from './policy.js';
import { sha256Hex } from './ledger.js';

const ACTION_LABELS = Object.freeze({
  erasure: "demande d'effacement",
  correction: 'demande de rectification',
  objection: "demande d'opposition",
  account_closure: 'demande de fermeture de compte',
  deindexing: 'demande de déréférencement',
});
const ENGLISH_ACTIONS = Object.freeze({
  erasure: 'erasure request',
  correction: 'rectification request',
  objection: 'objection request',
  account_closure: 'account closure request',
  deindexing: 'delisting request',
});

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${name} is required.`);
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
  if (url.protocol !== 'https:')
    throw new TypeError('contactRoute must be an HTTPS URL.');
  return url.href;
}

function requireCandidateUrl(candidate) {
  const candidateUrl = requireText(candidate?.url, 'candidate.url');
  let url;
  try {
    url = new URL(candidateUrl);
  } catch {
    throw new TypeError('candidate.url must be an HTTPS URL.');
  }
  if (url.protocol !== 'https:')
    throw new TypeError('candidate.url must be an HTTPS URL.');
  return candidateUrl;
}

export function createFranceEuDraft(input = {}) {
  const action = requireText(input.action, 'action');
  const language = input.language ?? 'en';
  if (!['en', 'fr'].includes(language))
    throw new TypeError('Draft language must be en or fr.');
  const actionLabel =
    ACTION_LABELS[action] ?? `demande relative à l'action « ${action} »`;
  const controllerName = requireText(input.controllerName, 'controllerName');
  const contactRoute = requireHttpsUrl(input.contactRoute);
  const candidateUrl = requireCandidateUrl(input.candidate);
  const body = (
    language === 'en'
      ? [
          'DRAFT — review and approve manually before taking any action.',
          '',
          `Subject: ${ENGLISH_ACTIONS[action] ?? action}`,
          `Data controller: ${controllerName}`,
          `Relevant URL: ${candidateUrl}`,
          `Unverified contact reference for manual checking: ${contactRoute}`,
          '',
          `I wish to make an ${ENGLISH_ACTIONS[action] ?? action} concerning the URL above. Please review this request and explain the outcome and any applicable limits.`,
          'This is an operational draft, not automatic submission or legal advice. It does not promise complete removal of data, an account, or all retained records.',
        ]
      : [
          'BROUILLON — à relire et à valider manuellement avant toute démarche.',
          '',
          `Objet : ${actionLabel}`,
          `Responsable du traitement : ${controllerName}`,
          `URL concernée : ${candidateUrl}`,
          `Référence de contact non vérifiée à contrôler manuellement : ${contactRoute}`,
          '',
          `Je souhaite exercer une ${actionLabel} concernant l’URL indiquée ci-dessus. Merci d’examiner cette demande et de m’indiquer la suite donnée, ainsi que toute limite applicable à ce droit.`,
          'Ce texte est un brouillon opérationnel, pas un envoi automatique ni un avis juridique. Il ne promet pas la suppression complète des données, du compte ou de tous les enregistrements conservés.',
        ]
  ).join('\n');

  return {
    status: 'draft',
    language,
    action,
    controllerName,
    contactRoute,
    routeVerification: 'unverified',
    body,
    approval: null,
    candidate: input.candidate ? { ...input.candidate } : null,
  };
}

export function approveDraft(draft, approval, caseRecord, nowMs) {
  if (!draft || draft.status !== 'draft')
    return {
      ok: false,
      code: 'DRAFT_NOT_APPROVABLE',
      message: 'Only a draft can be approved.',
    };
  if (
    !approval ||
    typeof approval.actor !== 'string' ||
    !approval.actor.trim()
  ) {
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED',
      message: 'Approval requires an explicit actor.',
    };
  }
  if (!Number.isFinite(nowMs))
    return {
      ok: false,
      code: 'APPROVAL_TIMESTAMP_REQUIRED',
      message: 'Approval requires an explicit timestamp.',
    };
  try {
    requireCandidateUrl(draft.candidate);
  } catch {
    return {
      ok: false,
      code: 'CANDIDATE_URL_REQUIRED',
      message: 'Approval requires an exact HTTPS candidate URL.',
    };
  }

  const authorization = canCreateRequest(
    caseRecord,
    draft.candidate,
    draft.action,
    nowMs,
  );
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

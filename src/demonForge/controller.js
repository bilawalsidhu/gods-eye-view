import { appendLedgerEvent, verifyLedger } from './ledger.js';
import { canCreateRequest, evaluateCaseAuthorization } from './policy.js';
import { approveDraft, createFranceEuDraft } from './requestStudio.js';
import {
  MAX_REPORT_FILE_BYTES,
  parseSocialAnalyzerReport,
} from './socialAnalyzerImport.js';
import {
  CASE_KIND,
  CANDIDATE_STATUS,
  REQUEST_STATUS,
  createCaseRecord,
} from './types.js';

function requiredElement(document, id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Demon Forge requires #${id}.`);
  return element;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function dateInputMs(value) {
  const normalized = text(value);
  if (!normalized) return null;
  const result = Date.parse(normalized);
  return Number.isFinite(result) ? result : null;
}

function commaList(value) {
  return [
    ...new Set(
      text(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function defaultCreateId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure opaque ID generation is unavailable.');
  }
  return globalThis.crypto.randomUUID();
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function initDemonForge({
  document,
  vault,
  now = Date.now,
  createId = defaultCreateId,
}) {
  if (
    !document ||
    !vault ||
    typeof now !== 'function' ||
    typeof createId !== 'function'
  ) {
    throw new TypeError(
      'Demon Forge requires document, vault, now, and createId dependencies.',
    );
  }

  const openButton = requiredElement(document, 'demon-forge-open');
  const dialog = requiredElement(document, 'demon-forge-dialog');
  const closeButton = requiredElement(document, 'demon-forge-close');
  const lockButton = requiredElement(document, 'demon-forge-lock');
  const unlockForm = requiredElement(document, 'demon-forge-unlock-form');
  const passphraseInput = requiredElement(document, 'demon-forge-passphrase');
  const caseIdInput = requiredElement(document, 'demon-forge-case-id');
  const caseKindInput = requiredElement(document, 'demon-forge-case-kind');
  const caseTitleInput = requiredElement(document, 'demon-forge-case-title');
  const caseCreateButton = requiredElement(document, 'demon-forge-case-create');
  const existingCasesInput = requiredElement(
    document,
    'demon-forge-existing-cases',
  );
  const caseOpenButton = requiredElement(document, 'demon-forge-case-open');
  const mandateSignedAtInput = requiredElement(
    document,
    'demon-forge-mandate-signed-at',
  );
  const mandateValidatedAtInput = requiredElement(
    document,
    'demon-forge-mandate-validated-at',
  );
  const mandateExpiresAtInput = requiredElement(
    document,
    'demon-forge-mandate-expires-at',
  );
  const mandateSourceCategoryInput = requiredElement(
    document,
    'demon-forge-mandate-source-category',
  );
  const mandateActionsInput = requiredElement(
    document,
    'demon-forge-mandate-actions',
  );
  const fileInput = requiredElement(document, 'demon-forge-import-file');
  const importStatus = requiredElement(document, 'demon-forge-import-status');
  const reviewList = requiredElement(document, 'demon-forge-review-list');
  const draftForm = requiredElement(document, 'demon-forge-draft-form');
  const actionSelect = requiredElement(document, 'demon-forge-action');
  const controllerNameInput = requiredElement(
    document,
    'demon-forge-controller-name',
  );
  const contactRouteInput = requiredElement(
    document,
    'demon-forge-contact-route',
  );
  const draftOutput = requiredElement(document, 'demon-forge-draft-output');
  const approveButton = requiredElement(document, 'demon-forge-approve');
  const approvalActor = requiredElement(document, 'demon-forge-approval-actor');
  const routeButton = requiredElement(document, 'demon-forge-official-route');
  const ledgerOutput = requiredElement(document, 'demon-forge-ledger-output');
  const workspaceStatus = requiredElement(document, 'demon-forge-status');

  let unlocked = false;
  let activeCase = null;
  let importedCandidates = [];
  let selectedCandidate = null;
  let currentDraft = null;
  let ledger = [];
  let workflow = [];
  let destroyed = false;
  let sessionGeneration = 0;
  let backgroundInert = null;
  let returnFocus = null;

  const listeners = [];
  function listen(target, eventName, handler) {
    target.addEventListener(eventName, handler);
    listeners.push(() => target.removeEventListener(eventName, handler));
  }

  function setStatus(message) {
    workspaceStatus.textContent = message;
  }

  function clearCaseState() {
    reviewList.replaceChildren();
    draftOutput.textContent = '';
    ledgerOutput.replaceChildren();
    importStatus.textContent = '';
    fileInput.value = '';
    caseIdInput.value = '';
    caseTitleInput.value = '';
    approvalActor.value = '';
    controllerNameInput.value = '';
    contactRouteInput.value = '';
    actionSelect.value = 'erasure';
    importedCandidates = [];
    selectedCandidate = null;
    currentDraft = null;
    ledger = [];
    workflow = [];
    activeCase = null;
    approveButton.disabled = true;
    routeButton.disabled = true;
  }

  function clearRenderedPersonalText() {
    clearCaseState();
    passphraseInput.value = '';
    existingCasesInput.replaceChildren();
    existingCasesInput.value = '';
  }

  function makeBackgroundInert() {
    if (backgroundInert || !document.body?.children) return;
    backgroundInert = new Map();
    for (const element of document.body.children) {
      if (element === dialog) continue;
      backgroundInert.set(element, Boolean(element.inert));
      element.inert = true;
    }
  }

  function restoreBackground() {
    if (!backgroundInert) return;
    for (const [element, wasInert] of backgroundInert) element.inert = wasInert;
    backgroundInert = null;
  }

  function focusableDialogElements() {
    return Array.from(
      dialog.querySelectorAll?.(FOCUSABLE_SELECTOR) ?? [],
    ).filter((element) => !element.disabled && !element.hidden);
  }

  function renderLedger() {
    ledgerOutput.replaceChildren();
    for (const event of ledger) {
      const item = document.createElement('li');
      item.textContent = `${event.sequence}. ${event.type} — ${event.actor}`;
      ledgerOutput.append(item);
    }
  }

  function applyActionScope() {
    const allowed =
      activeCase?.kind === CASE_KIND.NON_SELF
        ? new Set(activeCase.mandate?.permittedActions ?? [])
        : null;
    for (const option of actionSelect.options ?? []) {
      option.disabled = Boolean(allowed && !allowed.has(option.value));
    }
    if (allowed && !allowed.has(actionSelect.value))
      actionSelect.value = [...allowed][0] ?? '';
  }

  function caseRecordForSave() {
    if (!activeCase) throw new Error('CASE_REQUIRED');
    return {
      ...activeCase,
      status:
        currentDraft?.status ??
        (importedCandidates.length > 0 ? 'awaiting review' : 'draft'),
      candidates: importedCandidates,
      draft: currentDraft,
      ledger,
      workflow,
    };
  }

  async function saveActiveCase(options) {
    const record = caseRecordForSave();
    await vault.saveCase(record, options);
    activeCase = record;
  }

  async function persistEvent(type, actor, payload, options) {
    const previousLedger = ledger;
    ledger = appendLedgerEvent(ledger, { type, actor, payload }, now());
    try {
      await saveActiveCase(options);
    } catch (error) {
      ledger = previousLedger;
      throw error;
    }
    renderLedger();
  }

  function renderCandidates() {
    reviewList.replaceChildren();
    importedCandidates.forEach((candidate, index) => {
      const item = document.createElement('li');
      const description = document.createElement('span');
      description.textContent = `${candidate.provider}: ${candidate.username || candidate.url} (${candidate.confidence}%) · ${candidate.sourceCategory}`;
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.textContent =
        candidate.status === CANDIDATE_STATUS.CONFIRMED
          ? 'CONFIRMED'
          : 'CONFIRM';
      confirm.disabled = candidate.status === CANDIDATE_STATUS.CONFIRMED;
      confirm.addEventListener('click', async () => {
        if (!activeCase) return;
        const authorization = evaluateCaseAuthorization(activeCase, now());
        const allowedCategories = activeCase.mandate?.sourceCategories ?? [];
        if (
          !authorization.ok ||
          (activeCase.kind === CASE_KIND.NON_SELF &&
            !allowedCategories.includes(candidate.sourceCategory))
        ) {
          setStatus(
            `Candidate review blocked: ${authorization.ok ? 'source category is outside the signed mandate.' : authorization.message}`,
          );
          return;
        }
        const previousCandidates = importedCandidates;
        const previousSelected = selectedCandidate;
        const previousWorkflow = workflow;
        importedCandidates = importedCandidates.map(
          (entry, candidateIndex) => ({
            ...entry,
            status:
              candidateIndex === index
                ? CANDIDATE_STATUS.CONFIRMED
                : entry.status,
            ...(candidateIndex === index ? { confirmedAtMs: now() } : {}),
          }),
        );
        selectedCandidate = importedCandidates[index];
        workflow = [
          ...workflow,
          {
            type: 'CANDIDATE_CONFIRMED',
            atMs: selectedCandidate.confirmedAtMs,
            candidate: selectedCandidate,
          },
        ];
        try {
          await persistEvent('CANDIDATE_CONFIRMED', 'operator', {
            candidateId: selectedCandidate.id,
          });
          renderCandidates();
          setStatus('Candidate confirmed and recorded locally.');
        } catch (error) {
          importedCandidates = previousCandidates;
          selectedCandidate = previousSelected;
          workflow = previousWorkflow;
          setStatus(
            `Candidate confirmation was not saved: ${error?.code || error?.message || 'storage error'}.`,
          );
        }
      });
      item.append(description, confirm);
      reviewList.append(item);
    });
  }

  function activateCase(record) {
    const verified = verifyLedger(record?.ledger ?? []);
    if (!verified.ok)
      throw Object.assign(new Error(verified.code), { code: verified.code });
    activeCase = createCaseRecord(record);
    importedCandidates = activeCase.candidates;
    currentDraft = activeCase.draft;
    ledger = activeCase.ledger;
    workflow = activeCase.workflow;
    selectedCandidate =
      importedCandidates.find(
        (candidate) => candidate.status === CANDIDATE_STATUS.CONFIRMED,
      ) ?? null;
    caseIdInput.value = activeCase.id;
    caseTitleInput.value = activeCase.title;
    caseKindInput.value = activeCase.kind;
    draftOutput.textContent = currentDraft?.body ?? '';
    approveButton.disabled = currentDraft?.status !== 'draft';
    routeButton.disabled = true;
    applyActionScope();
    renderCandidates();
    renderLedger();
  }

  function renderExistingCases(summaries) {
    existingCasesInput.replaceChildren();
    for (const summary of summaries) {
      const option = document.createElement('option');
      option.value = summary.id;
      option.textContent = `${summary.id} · ${summary.status ?? REQUEST_STATUS.DRAFT}`;
      existingCasesInput.append(option);
    }
    existingCasesInput.value = summaries[0]?.id ?? '';
    caseOpenButton.disabled = summaries.length === 0;
  }

  async function lockWorkspace(
    message = 'Workspace locked. Rendered personal text cleared.',
  ) {
    sessionGeneration += 1;
    clearRenderedPersonalText();
    unlocked = false;
    try {
      await vault.lock();
    } finally {
      setStatus(message);
    }
  }

  function open() {
    if (destroyed || !dialog.hidden) return;
    returnFocus = openButton;
    dialog.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    makeBackgroundInert();
    closeButton.focus();
  }

  async function close() {
    if (destroyed) return;
    dialog.hidden = true;
    openButton.setAttribute('aria-expanded', 'false');
    const locking = lockWorkspace(
      'Workspace closed and locked. Rendered personal text cleared.',
    );
    restoreBackground();
    const focusTarget = returnFocus || openButton;
    returnFocus = null;
    focusTarget.focus();
    await locking;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    listeners.splice(0).forEach((remove) => remove());
    dialog.hidden = true;
    sessionGeneration += 1;
    clearRenderedPersonalText();
    restoreBackground();
    returnFocus?.focus();
    returnFocus = null;
    void vault.lock();
  }

  listen(openButton, 'click', open);
  listen(closeButton, 'click', () => {
    void close();
  });
  listen(lockButton, 'click', () => {
    void lockWorkspace();
  });
  listen(dialog, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableDialogElements();
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !dialog.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  });

  listen(unlockForm, 'submit', async (event) => {
    event.preventDefault();
    const unlockGeneration = sessionGeneration;
    try {
      await vault.unlock(passphraseInput.value);
      const summaries = await vault.listCaseSummaries();
      if (
        unlockGeneration !== sessionGeneration ||
        destroyed ||
        dialog.hidden
      ) {
        await vault.lock();
        return;
      }
      sessionGeneration += 1;
      unlocked = true;
      passphraseInput.value = '';
      renderExistingCases(summaries);
      setStatus(
        `Encrypted local vault authenticated. ${summaries.length} existing case(s) available.`,
      );
    } catch (error) {
      unlocked = false;
      void vault.lock();
      setStatus(
        `Vault authentication failed: ${error?.code || error?.message || 'unknown error'}`,
      );
    }
  });

  listen(caseCreateButton, 'click', async () => {
    if (!unlocked) {
      setStatus('Authenticate the encrypted local vault first.');
      return;
    }
    try {
      const kind = caseKindInput.value;
      const mandate =
        kind === CASE_KIND.NON_SELF
          ? {
              sourceCategories: [text(mandateSourceCategoryInput.value)].filter(
                Boolean,
              ),
              permittedActions: commaList(mandateActionsInput.value),
              expiresAtMs: dateInputMs(mandateExpiresAtInput.value),
              proof: {
                signedAtMs: dateInputMs(mandateSignedAtInput.value),
                validatedAtMs: dateInputMs(mandateValidatedAtInput.value),
              },
            }
          : {};
      const id = createId();
      if (
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(id)
      ) {
        throw new Error('Secure opaque case ID generation failed.');
      }
      activeCase = createCaseRecord({
        id,
        title: text(caseTitleInput.value),
        kind,
        mandate,
      });
      const authorization = evaluateCaseAuthorization(activeCase, now());
      if (!authorization.ok)
        throw Object.assign(new Error(authorization.message), {
          code: authorization.code,
        });
      ledger = appendLedgerEvent(
        [],
        { type: 'CASE_CREATED', actor: 'case-owner', payload: { kind } },
        now(),
      );
      importedCandidates = [];
      selectedCandidate = null;
      currentDraft = null;
      workflow = [];
      await saveActiveCase({ create: true });
      activateCase(activeCase);
      setStatus('New authorized case created with an opaque local ID.');
    } catch (error) {
      clearCaseState();
      setStatus(
        `Case creation rejected: ${error?.code || error?.message || 'invalid case'}`,
      );
    }
  });

  listen(caseOpenButton, 'click', async () => {
    if (!unlocked || !text(existingCasesInput.value)) return;
    try {
      const record = await vault.loadCase(existingCasesInput.value);
      if (!record) throw new Error('CASE_NOT_FOUND');
      activateCase(record);
      await persistEvent('CASE_OPENED', 'operator', null);
      setStatus(
        'Existing encrypted case authenticated and restored with its full ledger.',
      );
    } catch (error) {
      clearCaseState();
      setStatus(
        `Existing case could not be opened: ${error?.code || error?.message || 'invalid case'}`,
      );
    }
  });

  listen(fileInput, 'change', async () => {
    if (!unlocked || !activeCase) {
      importStatus.textContent =
        'Authenticate the vault and create or open an authorized case first.';
      fileInput.value = '';
      return;
    }
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.type !== 'application/json') {
      importStatus.textContent = 'Choose an application/json file.';
      fileInput.value = '';
      return;
    }
    if (
      !Number.isFinite(file.size) ||
      file.size < 0 ||
      file.size > MAX_REPORT_FILE_BYTES
    ) {
      importStatus.textContent =
        'Import rejected: file exceeds the 2 MiB cap or has no trustworthy size.';
      fileInput.value = '';
      return;
    }
    const authorization = evaluateCaseAuthorization(activeCase, now());
    if (!authorization.ok) {
      importStatus.textContent = `Import blocked: ${authorization.message}`;
      fileInput.value = '';
      return;
    }
    const importGeneration = sessionGeneration;
    try {
      const localText = await file.text();
      if (!unlocked || importGeneration !== sessionGeneration || destroyed)
        return;
      const report = parseSocialAnalyzerReport(localText, {
        importedAtMs: now(),
        candidateIdFactory: createId,
      });
      const previousCandidates = importedCandidates;
      const previousSelected = selectedCandidate;
      const previousDraft = currentDraft;
      const previousWorkflow = workflow;
      importedCandidates = report.candidates;
      selectedCandidate = null;
      currentDraft = null;
      workflow = [
        ...workflow,
        {
          type: 'REPORT_IMPORTED',
          atMs: report.importedAtMs,
          source: report.source,
          candidates: report.candidates,
        },
      ];
      approveButton.disabled = true;
      routeButton.disabled = true;
      try {
        await persistEvent('REPORT_IMPORTED', 'operator', {
          candidateCount: importedCandidates.length,
          source: report.source,
        });
      } catch (error) {
        importedCandidates = previousCandidates;
        selectedCandidate = previousSelected;
        currentDraft = previousDraft;
        workflow = previousWorkflow;
        throw error;
      }
      importStatus.textContent = `${importedCandidates.length} local candidate(s) imported and recorded.`;
      renderCandidates();
    } catch (error) {
      if (importGeneration !== sessionGeneration || !unlocked || destroyed)
        return;
      importStatus.textContent = `Import rejected: ${error?.code || error?.message || 'invalid report'}`;
    }
  });

  listen(draftForm, 'submit', async (event) => {
    event.preventDefault();
    if (!unlocked || !activeCase || !selectedCandidate) {
      setStatus('Open an authorized case and confirm a candidate first.');
      return;
    }
    const fields = new FormData(draftForm);
    const action = fields.get('action');
    const permission = canCreateRequest(
      activeCase,
      selectedCandidate,
      action,
      now(),
    );
    if (!permission.ok) {
      setStatus(`Draft blocked: ${permission.message}`);
      return;
    }
    const previousDraft = currentDraft;
    const previousWorkflow = workflow;
    try {
      currentDraft = createFranceEuDraft({
        action,
        language:
          document.getElementById('demon-forge-draft-language')?.value || 'en',
        controllerName: fields.get('controllerName'),
        contactRoute: fields.get('contactRoute'),
        candidate: selectedCandidate,
      });
      workflow = [
        ...workflow,
        { type: 'REQUEST_DRAFTED', atMs: now(), draft: currentDraft },
      ];
      await persistEvent('REQUEST_DRAFTED', 'operator', {
        action,
        candidateId: selectedCandidate.id,
      });
      draftOutput.textContent = currentDraft.body;
      approveButton.disabled = false;
      routeButton.disabled = true;
      setStatus(
        'Draft created locally. Its contact route is unverified and cannot be opened here.',
      );
    } catch (error) {
      currentDraft = previousDraft;
      workflow = previousWorkflow;
      setStatus(
        `Draft rejected: ${error?.code || error?.message || 'invalid fields'}`,
      );
    }
  });

  listen(approveButton, 'click', async () => {
    if (!currentDraft || !activeCase) return;
    const previousDraft = currentDraft;
    const previousWorkflow = workflow;
    const approved = approveDraft(
      currentDraft,
      { actor: approvalActor.value },
      activeCase,
      now(),
    );
    if (approved?.ok === false) {
      setStatus(`Approval rejected: ${approved.message}`);
      return;
    }
    currentDraft = approved;
    workflow = [
      ...workflow,
      {
        type: 'REQUEST_APPROVED',
        atMs: approved.approval.approvedAtMs,
        draft: approved,
      },
    ];
    try {
      await persistEvent('REQUEST_APPROVED', approved.approval.actor, {
        action: approved.action,
        renderedBodyHash: approved.approval.renderedBodyHash,
      });
      approveButton.disabled = true;
      routeButton.disabled = true;
      draftOutput.textContent = currentDraft.body;
      setStatus(
        'Draft approved locally. Handoff remains disabled until a verified source directory exists.',
      );
    } catch (error) {
      currentDraft = previousDraft;
      workflow = previousWorkflow;
      setStatus(
        `Approval was not saved: ${error?.code || error?.message || 'storage error'}.`,
      );
    }
  });

  listen(routeButton, 'click', () => {
    routeButton.disabled = true;
    setStatus(
      'Handoff disabled: no verified source directory is available. Nothing was opened or sent.',
    );
  });

  dialog.hidden = true;
  openButton.setAttribute('aria-expanded', 'false');
  caseOpenButton.disabled = true;
  approveButton.disabled = true;
  routeButton.disabled = true;

  return Object.freeze({ open, close, destroy });
}

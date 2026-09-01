import { appendLedgerEvent } from './ledger.js';
import { approveDraft, createFranceEuDraft } from './requestStudio.js';
import { parseSocialAnalyzerReport } from './socialAnalyzerImport.js';
import { CANDIDATE_STATUS, createCaseRecord } from './types.js';

function requiredElement(document, id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Demon Forge requires #${id}.`);
  return element;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function initDemonForge({ document, vault, now = Date.now }) {
  if (!document || !vault || typeof now !== 'function') {
    throw new TypeError('Demon Forge requires document, vault, and now dependencies.');
  }

  const openButton = requiredElement(document, 'demon-forge-open');
  const dialog = requiredElement(document, 'demon-forge-dialog');
  const closeButton = requiredElement(document, 'demon-forge-close');
  const lockButton = requiredElement(document, 'demon-forge-lock');
  const unlockForm = requiredElement(document, 'demon-forge-unlock-form');
  const passphraseInput = requiredElement(document, 'demon-forge-passphrase');
  const caseIdInput = requiredElement(document, 'demon-forge-case-id');
  const fileInput = requiredElement(document, 'demon-forge-import-file');
  const importStatus = requiredElement(document, 'demon-forge-import-status');
  const reviewList = requiredElement(document, 'demon-forge-review-list');
  const draftForm = requiredElement(document, 'demon-forge-draft-form');
  const actionSelect = requiredElement(document, 'demon-forge-action');
  const controllerNameInput = requiredElement(document, 'demon-forge-controller-name');
  const contactRouteInput = requiredElement(document, 'demon-forge-contact-route');
  const draftOutput = requiredElement(document, 'demon-forge-draft-output');
  const approveButton = requiredElement(document, 'demon-forge-approve');
  const approvalActor = requiredElement(document, 'demon-forge-approval-actor');
  const routeButton = requiredElement(document, 'demon-forge-official-route');
  const ledgerOutput = requiredElement(document, 'demon-forge-ledger-output');
  const workspaceStatus = requiredElement(document, 'demon-forge-status');
  const window = document.defaultView;

  let unlocked = false;
  let importedCandidates = [];
  let selectedCandidate = null;
  let currentDraft = null;
  let ledger = [];
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

  function clearRenderedPersonalText() {
    reviewList.replaceChildren();
    draftOutput.textContent = '';
    ledgerOutput.replaceChildren();
    importStatus.textContent = '';
    fileInput.value = '';
    passphraseInput.value = '';
    caseIdInput.value = '';
    approvalActor.value = '';
    controllerNameInput.value = '';
    contactRouteInput.value = '';
    actionSelect.value = 'erasure';
    importedCandidates = [];
    selectedCandidate = null;
    currentDraft = null;
    ledger = [];
    approveButton.disabled = true;
    routeButton.disabled = true;
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
    return Array.from(dialog.querySelectorAll?.(FOCUSABLE_SELECTOR) ?? [])
      .filter((element) => !element.disabled && !element.hidden);
  }

  async function lockWorkspace(message = 'Workspace locked. Rendered personal text cleared.') {
    sessionGeneration += 1;
    clearRenderedPersonalText();
    unlocked = false;
    try {
      await vault.lock();
    } finally {
      setStatus(message);
    }
  }

  async function saveLocalCase({ required = false } = {}) {
    if (!unlocked) {
      if (required) throw new Error('VAULT_LOCKED');
      return false;
    }
    const id = text(caseIdInput.value);
    if (!id) {
      if (required) throw new Error('CASE_ID_REQUIRED');
      return false;
    }
    await vault.saveCase({
      id,
      status: currentDraft?.status ?? 'review',
      candidates: importedCandidates,
      draft: currentDraft,
      ledger,
    });
    return true;
  }

  function renderLedger() {
    ledgerOutput.replaceChildren();
    for (const event of ledger) {
      const item = document.createElement('li');
      item.textContent = `${event.sequence}. ${event.type} — ${event.actor}`;
      ledgerOutput.append(item);
    }
  }

  function renderCandidates() {
    reviewList.replaceChildren();
    importedCandidates.forEach((candidate, index) => {
      const item = document.createElement('li');
      const description = document.createElement('span');
      description.textContent = `${candidate.provider}: ${candidate.username || candidate.url} (${candidate.confidence}%)`;
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.textContent = candidate.status === CANDIDATE_STATUS.CONFIRMED ? 'CONFIRMED' : 'CONFIRM';
      confirm.disabled = candidate.status === CANDIDATE_STATUS.CONFIRMED;
      confirm.addEventListener('click', async () => {
        importedCandidates = importedCandidates.map((entry, candidateIndex) => ({
          ...entry,
          status: candidateIndex === index ? CANDIDATE_STATUS.CONFIRMED : entry.status,
          ...(candidateIndex === index ? { confirmedAtMs: now() } : {}),
        }));
        selectedCandidate = importedCandidates[index];
        renderCandidates();
        setStatus('Candidate confirmed locally.');
        await saveLocalCase();
      });
      item.append(description, confirm);
      reviewList.append(item);
    });
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
    const locking = lockWorkspace('Workspace closed and locked. Rendered personal text cleared.');
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
  listen(closeButton, 'click', () => { void close(); });
  listen(lockButton, 'click', () => { void lockWorkspace(); });
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
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  listen(unlockForm, 'submit', async (event) => {
    event.preventDefault();
    const unlockGeneration = sessionGeneration;
    try {
      await vault.unlock(passphraseInput.value);
      if (unlockGeneration !== sessionGeneration || destroyed || dialog.hidden) {
        await vault.lock();
        return;
      }
      sessionGeneration += 1;
      unlocked = true;
      passphraseInput.value = '';
      setStatus('Encrypted local workspace unlocked.');
    } catch (error) {
      unlocked = false;
      setStatus(`Unlock failed: ${error?.code || error?.message || 'unknown error'}`);
    }
  });

  listen(fileInput, 'change', async () => {
    if (!unlocked) {
      importStatus.textContent = 'Unlock the local workspace first.';
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
    const importGeneration = sessionGeneration;
    try {
      const localText = await file.text();
      if (!unlocked || importGeneration !== sessionGeneration || destroyed) return;
      const report = parseSocialAnalyzerReport(localText, { importedAtMs: now() });
      importedCandidates = report.candidates;
      selectedCandidate = null;
      currentDraft = null;
      routeButton.disabled = true;
      approveButton.disabled = true;
      importStatus.textContent = `${importedCandidates.length} local candidate(s) imported.`;
      renderCandidates();
      await saveLocalCase();
    } catch (error) {
      if (importGeneration !== sessionGeneration || !unlocked || destroyed) return;
      importStatus.textContent = `Import rejected: ${error?.code || error?.message || 'invalid report'}`;
    }
  });

  listen(draftForm, 'submit', async (event) => {
    event.preventDefault();
    if (!unlocked || !selectedCandidate) {
      setStatus('Unlock the workspace and confirm a candidate first.');
      return;
    }
    const fields = new FormData(draftForm);
    try {
      currentDraft = createFranceEuDraft({
        action: fields.get('action'),
        controllerName: fields.get('controllerName'),
        contactRoute: fields.get('contactRoute'),
        candidate: selectedCandidate,
      });
      draftOutput.textContent = currentDraft.body;
      approveButton.disabled = false;
      routeButton.disabled = true;
      setStatus('Draft created locally. Review and approve it explicitly.');
      await saveLocalCase();
    } catch (error) {
      setStatus(`Draft rejected: ${error?.message || 'invalid fields'}`);
    }
  });

  listen(approveButton, 'click', async () => {
    if (!currentDraft) return;
    const approved = approveDraft(
      currentDraft,
      { actor: approvalActor.value },
      createCaseRecord({ kind: 'self' }),
      now(),
    );
    if (approved?.ok === false) {
      setStatus(`Approval rejected: ${approved.message}`);
      return;
    }
    currentDraft = approved;
    approveButton.disabled = true;
    routeButton.disabled = false;
    draftOutput.textContent = currentDraft.body;
    setStatus('Draft approved locally. The official route may now be opened manually.');
    await saveLocalCase();
  });

  listen(routeButton, 'click', async () => {
    if (currentDraft?.status !== 'approved' || routeButton.disabled) return;
    const route = currentDraft.contactRoute;
    const actor = currentDraft.approval.actor;
    const ledgerBeforeAttempt = ledger;
    const routeGeneration = sessionGeneration;
    routeButton.disabled = true;

    try {
      ledger = appendLedgerEvent(ledger, {
        type: 'MANUAL_ROUTE_ATTEMPTED',
        actor,
        payload: { route },
      }, now());
      await saveLocalCase({ required: true });
      if (routeGeneration !== sessionGeneration || !unlocked || destroyed) return;
    } catch (error) {
      if (routeGeneration !== sessionGeneration || !unlocked || destroyed) return;
      ledger = ledgerBeforeAttempt;
      renderLedger();
      routeButton.disabled = false;
      setStatus(`Official route handoff not attempted: audit record was not saved (${error?.message || 'storage error'}).`);
      return;
    }

    let handoffTriggered = true;
    try {
      window.open(route, '_blank', 'noopener,noreferrer');
    } catch {
      handoffTriggered = false;
    }

    const ledgerBeforeDecision = ledger;
    ledger = appendLedgerEvent(ledger, {
      type: handoffTriggered ? 'MANUAL_ROUTE_HANDOFF_TRIGGERED' : 'MANUAL_ROUTE_HANDOFF_FAILED',
      actor,
      payload: { route },
    }, now());
    try {
      await saveLocalCase({ required: true });
      if (routeGeneration !== sessionGeneration || !unlocked || destroyed) return;
      renderLedger();
      setStatus(handoffTriggered
        ? 'Browser handoff triggered; whether the official route opened is unknown. Nothing was sent.'
        : 'Browser handoff failed before an official route could be requested. Nothing was sent.');
    } catch (error) {
      if (routeGeneration !== sessionGeneration || !unlocked || destroyed) return;
      ledger = ledgerBeforeDecision;
      renderLedger();
      setStatus(`Official route audit persistence failed after the browser decision: ${error?.message || 'storage error'}.`);
    } finally {
      if (routeGeneration === sessionGeneration && unlocked && !destroyed) routeButton.disabled = false;
    }
  });

  dialog.hidden = true;
  openButton.setAttribute('aria-expanded', 'false');
  approveButton.disabled = true;
  routeButton.disabled = true;

  return Object.freeze({ open, close, destroy });
}

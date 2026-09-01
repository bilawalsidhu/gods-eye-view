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
    importedCandidates = [];
    selectedCandidate = null;
    currentDraft = null;
    ledger = [];
    approveButton.disabled = true;
    routeButton.disabled = true;
  }

  async function lockWorkspace(message = 'Workspace locked. Rendered personal text cleared.') {
    clearRenderedPersonalText();
    unlocked = false;
    try {
      await vault.lock();
    } finally {
      setStatus(message);
    }
  }

  async function saveLocalCase() {
    if (!unlocked) return;
    const id = text(caseIdInput.value);
    if (!id) return;
    await vault.saveCase({
      id,
      status: currentDraft?.status ?? 'review',
      candidates: importedCandidates,
      draft: currentDraft,
      ledger,
    });
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
    if (destroyed) return;
    dialog.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    closeButton.focus();
  }

  async function close() {
    if (destroyed) return;
    dialog.hidden = true;
    openButton.setAttribute('aria-expanded', 'false');
    await lockWorkspace('Workspace closed and locked. Rendered personal text cleared.');
    openButton.focus();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    listeners.splice(0).forEach((remove) => remove());
    dialog.hidden = true;
    clearRenderedPersonalText();
    void vault.lock();
  }

  listen(openButton, 'click', open);
  listen(closeButton, 'click', () => { void close(); });
  listen(lockButton, 'click', () => { void lockWorkspace(); });
  listen(dialog, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    void close();
  });

  listen(unlockForm, 'submit', async (event) => {
    event.preventDefault();
    try {
      await vault.unlock(passphraseInput.value);
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
    try {
      const report = parseSocialAnalyzerReport(await file.text(), { importedAtMs: now() });
      importedCandidates = report.candidates;
      selectedCandidate = null;
      currentDraft = null;
      routeButton.disabled = true;
      approveButton.disabled = true;
      importStatus.textContent = `${importedCandidates.length} local candidate(s) imported.`;
      renderCandidates();
      await saveLocalCase();
    } catch (error) {
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
    window.open(route, '_blank', 'noopener,noreferrer');
    ledger = appendLedgerEvent(ledger, {
      type: 'MANUAL_ROUTE_OPENED',
      actor: currentDraft.approval.actor,
      payload: { route },
    }, now());
    renderLedger();
    setStatus('Official route opened manually; local ledger updated. Nothing was sent.');
    await saveLocalCase();
  });

  dialog.hidden = true;
  openButton.setAttribute('aria-expanded', 'false');
  approveButton.disabled = true;
  routeButton.disabled = true;

  return Object.freeze({ open, close, destroy });
}

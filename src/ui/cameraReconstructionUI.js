import { cameraReconstructionCapability } from './cameraReconstruction.js';

/** Separate generated reconstruction from factual analysis and local adjustments. */
export class CameraReconstructionUI {
  constructor(
    snapshot,
    { readCapability = cameraReconstructionCapability } = {},
  ) {
    this.snapshot = snapshot;
    this.readCapability = readCapability;
    const section = snapshot.doc.createElement('section');
    section.className = 'snapshot-generation';
    section.hidden = true;
    section.innerHTML = `<h3 tabindex="-1">AI image reconstruction</h3><p>AI can invent details. This is reconstruction, not factual recovered detail. Your original is preserved. Local crop/contrast/sharpening remains a separate action.</p><label>Generate for<select class="snapshot-generation-scope"><option value="whole">Whole camera image</option><option value="region">Selected area only</option></select></label><p class="snapshot-generation-target"></p><label>Optional generation instruction<textarea class="snapshot-generation-note" maxlength="1500" rows="2" placeholder="Optional instruction; it can influence invented details"></textarea></label><p class="snapshot-generation-model"></p><div class="snapshot-tools"><button type="button" data-action="generate" disabled>GENERATE AI RECONSTRUCTION</button><button type="button" data-action="cancel-generate" disabled>CANCEL GENERATION</button><button type="button" data-action="reset-generation">RESET GENERATED RESULT</button></div><p class="snapshot-generation-status" role="status" aria-live="polite"></p><progress class="snapshot-generation-progress" aria-label="AI generation in progress" hidden></progress><div class="snapshot-generation-comparison"><figure><figcaption>Preserved original snapshot</figcaption><canvas class="snapshot-generation-original" aria-label="Preserved original snapshot"></canvas></figure><figure class="snapshot-generation-result" hidden><figcaption>AI RECONSTRUCTION — NOT RECOVERED EVIDENCE</figcaption><canvas class="snapshot-generation-output" aria-label="AI reconstructed result"></canvas><p class="snapshot-generation-result-label"></p><button type="button" data-action="save-generated">SAVE AI RECONSTRUCTION PNG</button></figure></div>`;
    snapshot.dialog.insertBefore(
      section,
      snapshot.dialog.querySelector('.snapshot-status'),
    );
    this.section = section;
    snapshot.listen(
      section.querySelector('.snapshot-generation-scope'),
      'change',
      () => this.syncTarget(),
    );
  }
  input() {
    const s = this.snapshot,
      scope = this.section.querySelector('.snapshot-generation-scope').value;
    if (!s.original) return null;
    const frameHeight = s.frameHeight || Math.max(1, s.original.height - 64),
      selected = s.getSelection();
    const bounds =
      scope === 'region' && selected
        ? { ...selected.pixelBounds }
        : scope === 'whole'
          ? { x: 0, y: 0, width: s.original.width, height: frameHeight }
          : null;
    if (!bounds || bounds.y >= frameHeight) return null;
    bounds.height = Math.min(bounds.height, frameHeight - bounds.y);
    if (bounds.width < 3 || bounds.height < 3) return null;
    const canvas = s.doc.createElement('canvas');
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    canvas
      .getContext('2d')
      .drawImage(
        s.original,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        0,
        0,
        bounds.width,
        bounds.height,
      );
    return { scope, bounds, canvas };
  }
  syncTarget() {
    const s = this.snapshot,
      input = this.input(),
      key = JSON.stringify({
        at: s.capturedAt?.toISOString(),
        scope: this.section.querySelector('.snapshot-generation-scope').value,
        bounds: input?.bounds,
      });
    if (key !== this.targetKey) {
      this.cancel(false);
      this.targetKey = key;
      this.resultCanvas = this.resultBlob = null;
      this.section.querySelector('.snapshot-generation-result').hidden = true;
    }
    const selectedOption = this.section.querySelector('option[value="region"]');
    selectedOption.disabled = !s.getSelection();
    const description =
      input?.scope === 'whole'
        ? 'Whole original camera frame'
        : 'Selected pristine original crop';
    this.section.querySelector('.snapshot-generation-target').textContent =
      input
        ? `${description}: ${input.canvas.width} × ${input.canvas.height} pixels will be sent. Added download caption, annotations and local enhancements are excluded.`
        : 'No usable selected camera area. Draw within the camera image or choose Whole camera image.';
    const original = this.section.querySelector(
      '.snapshot-generation-original',
    );
    if (s.original) {
      original.width = s.original.width;
      original.height = s.original.height;
      original.getContext('2d').drawImage(s.original, 0, 0);
    }
    this.controls();
  }
  controls() {
    const busy = !!this.pending;
    this.section.querySelector('[data-action="generate"]').disabled =
      busy || !this.input() || typeof this.capability?.generate !== 'function';
    this.section.querySelector('[data-action="cancel-generate"]').disabled =
      !busy;
    this.section.querySelector('.snapshot-generation-progress').hidden = !busy;
    this.section.querySelector('.snapshot-generation-scope').disabled = busy;
    this.section.querySelector('.snapshot-generation-note').disabled = busy;
    this.section.setAttribute('aria-busy', String(busy));
    this.snapshot.syncAiControls();
  }
  async open() {
    this.section.hidden = false;
    if (!this.scopeInitialized) {
      this.section.querySelector('.snapshot-generation-scope').value =
        this.snapshot.getSelection() ? 'region' : 'whole';
      this.scopeInitialized = true;
    }
    this.syncTarget();
    this.snapshot.reveal('.snapshot-generation h3');
    if (this.pending) return;
    this.lookup?.abort();
    const lookup = new AbortController();
    this.lookup = lookup;
    this.capability = null;
    this.controls();
    this.section.querySelector('.snapshot-generation-model').textContent =
      'Checking approved image-generation setup. No image is sent.';
    let capability;
    try {
      capability = await this.readCapability(lookup.signal);
    } catch {
      capability = {
        error:
          'Approved generation setup could not be checked. No image has been sent.',
      };
    }
    if (lookup.signal.aborted || this.lookup !== lookup) return;
    this.capability = capability;
    this.section.querySelector('.snapshot-generation-model').textContent =
      typeof capability?.generate === 'function'
        ? `${capability.provider} / ${capability.model}. ${capability.priceLabel}. ${capability.warning || ''}`
        : capability?.error ||
          'Choose and approve a provider/model/cost first. Generation is disabled.';
    this.snapshot.status(
      typeof capability?.generate === 'function'
        ? 'Review the input and optional instruction, then click Generate. API charges apply.'
        : capability?.error || 'Generation is not configured.',
      'generation',
    );
    this.controls();
  }
  cancel(feedback = true) {
    const request = this.request;
    request?.abort();
    this.request = null;
    this.pending = false;
    if (request && feedback)
      this.snapshot.status(
        'Generation canceled. A paid request already sent cannot be recalled. Original unchanged.',
        'generation',
      );
    if (this.section) this.controls();
  }
  reset() {
    this.lookup?.abort();
    this.lookup = null;
    this.cancel(false);
    this.capability = null;
    this.resultCanvas = this.resultBlob = null;
    this.targetKey = undefined;
    this.scopeInitialized = false;
    if (this.section) {
      this.section.hidden = true;
      this.section.querySelector('.snapshot-generation-result').hidden = true;
      this.section.querySelector('.snapshot-generation-note').value = '';
    }
  }
  async generate() {
    if (this.pending) return;
    const input = this.input(),
      capability = this.capability;
    if (!input || typeof capability?.generate !== 'function') {
      this.snapshot.status(
        'Generation requires a usable original input and approved provider/model/cost.',
        'generation',
      );
      return;
    }
    const s = this.snapshot,
      epoch = s.epoch,
      key = this.targetKey,
      request = new AbortController(),
      note = this.section.querySelector('.snapshot-generation-note').value;
    this.request = request;
    this.pending = true;
    this.resultCanvas = this.resultBlob = null;
    this.section.querySelector('.snapshot-generation-result').hidden = true;
    this.controls();
    s.status(
      'Generating AI reconstruction… It may invent details; the original is unchanged.',
      'generation',
    );
    s.reveal('[data-action="generate"]');
    try {
      const result = await capability.generate({
        sourceImage: input.canvas,
        scope: input.scope,
        note,
        cameraId: s.cameraId,
        signal: request.signal,
      });
      if (
        request.signal.aborted ||
        this.request !== request ||
        epoch !== s.epoch ||
        key !== this.targetKey
      )
        return;
      if (
        typeof result?.image !== 'string' ||
        result.image.length > 8 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.image)
      )
        throw Error('Unsupported generated image');
      const image = s.doc.createElement('img');
      image.src = result.image;
      await image.decode();
      if (
        request.signal.aborted ||
        this.request !== request ||
        epoch !== s.epoch ||
        key !== this.targetKey
      )
        return;
      if (
        image.naturalWidth > 2048 ||
        image.naturalHeight > 2048 ||
        image.naturalWidth < 1 ||
        image.naturalHeight < 1
      )
        throw Error('Generated image exceeds limits');
      const canvas = s.doc.createElement('canvas');
      if (input.scope === 'region') {
        canvas.width = s.original.width;
        canvas.height = s.original.height + 64;
        canvas.getContext('2d').drawImage(s.original, 0, 0);
        const b = input.bounds;
        canvas.getContext('2d').drawImage(image, b.x, b.y, b.width, b.height);
      } else {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight + 64;
        canvas.getContext('2d').drawImage(image, 0, 0);
      }
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#07121b';
      ctx.fillRect(0, canvas.height - 64, canvas.width, 64);
      ctx.fillStyle = '#fff';
      ctx.font = '14px sans-serif';
      ctx.fillText(
        'AI RECONSTRUCTION — NOT FACTUAL RECOVERED DETAIL',
        8,
        canvas.height - 40,
        canvas.width - 16,
      );
      ctx.fillText(
        `${result.provider || capability.provider} / ${result.model || capability.model} | ${input.scope === 'region' ? 'Selected area generated; exterior original preserved' : 'Whole image generated'}`,
        8,
        canvas.height - 17,
        canvas.width - 16,
      );
      const blob = await s.blob(canvas);
      if (
        request.signal.aborted ||
        this.request !== request ||
        epoch !== s.epoch ||
        key !== this.targetKey
      )
        return;
      this.resultCanvas = canvas;
      this.resultBlob = blob;
      const displayed = this.section.querySelector(
        '.snapshot-generation-output',
      );
      displayed.width = canvas.width;
      displayed.height = canvas.height;
      displayed.getContext('2d').drawImage(canvas, 0, 0);
      this.section.querySelector('.snapshot-generation-result').hidden = false;
      this.section.querySelector(
        '.snapshot-generation-result-label',
      ).textContent =
        input.scope === 'region'
          ? 'Generated pixels replace only the selected bounding rectangle in this separate copy. All exterior original pixels are preserved.'
          : 'Generated whole-image reconstruction; it may differ from reality. Original remains separate.';
      s.status(
        `AI reconstruction complete. ${Number.isFinite(result.costUsd) ? `Reported-token cost $${result.costUsd.toFixed(6)}. ` : 'Actual charge unknown. '}${result.budget ? `$${result.budget.remainingAllocationUsd.toFixed(6)} image allowance unallocated; ${result.budget.remainingAttempts} attempts remain. ` : ''}Verify factual details against the original.`,
        'generation',
      );
      s.reveal('.snapshot-generation-comparison');
    } catch (e) {
      if (this.request === request)
        s.status(
          e.name === 'AbortError'
            ? 'Generation canceled. Original unchanged.'
            : `${e.message || 'AI reconstruction failed.'} Original unchanged. No automatic retry.`,
          'generation',
        );
    } finally {
      if (this.request === request) {
        this.request = null;
        this.pending = false;
        // Refresh the server's durable allowance after success/failure/cancel.
        try {
          this.capability = await this.readCapability();
          this.section.querySelector('.snapshot-generation-model').textContent =
            this.capability.priceLabel || this.capability.error || '';
        } catch {
          this.capability = null;
        }
        this.controls();
      }
    }
  }
  async action(action) {
    if (action === 'open-generate') return this.open();
    if (action === 'generate') return this.generate();
    if (action === 'cancel-generate') return this.cancel();
    if (action === 'reset-generation') {
      this.cancel(false);
      this.resultCanvas = this.resultBlob = null;
      this.section.querySelector('.snapshot-generation-result').hidden = true;
      this.snapshot.status(
        'Generated result reset. The original is unchanged.',
        'generation',
      );
      return;
    }
    if (action === 'save-generated' && this.resultBlob) {
      const name = `camera-${String(this.snapshot.cameraId || 'frame').replace(/[^a-z0-9_-]/gi, '-')}-${this.snapshot.capturedAt.toISOString().replace(/[:.]/g, '-')}-ai-reconstruction.png`;
      this.snapshot.download(this.resultBlob, name);
      this.snapshot.status(
        'Labeled AI reconstruction PNG download requested. Original unchanged.',
        'generation',
      );
    }
  }
}

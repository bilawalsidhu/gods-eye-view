/** Local, user-triggered camera capture and pixel-preserving annotation. */
import { snapshotSelection } from '../cameraSnapshotSelection.js';
import { enhanceSnapshotPixels } from './cameraSnapshotEnhancement.js';
import { CameraReconstructionUI } from './cameraReconstructionUI.js';
export function snapshotFilename(id, date = new Date()) {
  return `camera-${String(id || 'frame')
    .replace(/[^a-z0-9_-]/gi, '-')
    .slice(0, 70)}-${date.toISOString().replace(/[:.]/g, '-')}.png`;
}
export function imagePoint(event, rect) {
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}
export function regionBounds(points) {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}
export class CameraSnapshot {
  constructor({
    button,
    video,
    getVideo = () => null,
    image,
    readState,
    showToast,
    readAi = () => null,
    enhancePixels = enhanceSnapshotPixels,
    documentRef = document,
  }) {
    Object.assign(this, {
      button,
      video,
      getVideo,
      image,
      readState,
      showToast,
      readAi,
      enhancePixels,
      doc: documentRef,
    });
    this.strokes = [];
    this.mode = 'marker';
    this.epoch = 0;
    this.urls = new Set();
    this.downloadTimers = new Set();
    this.touchFallbacks = new WeakMap();
    this.listeners = new AbortController();
    if (!button) return;
    this.dialog = this.doc.createElement('dialog');
    this.dialog.id = 'cctv-snapshot-preview';
    this.dialog.setAttribute('aria-labelledby', 'snapshot-title');
    this.dialog.innerHTML = `<header><h2 id="snapshot-title">Camera snapshot</h2><button type="button" data-action="close" aria-label="Close snapshot preview">CLOSE</button></header><p class="snapshot-caption"></p><canvas class="snapshot-canvas" aria-label="Snapshot annotation canvas"></canvas><p class="snapshot-selection-summary" role="status" aria-live="polite"></p><div class="snapshot-tools"><button type="button" data-action="marker" aria-pressed="true">MARKER</button><button type="button" data-action="circle" aria-pressed="false">CIRCLE</button><button type="button" data-action="region" aria-pressed="false">REGION</button><button type="button" data-action="undo">UNDO</button><button type="button" data-action="clear">CLEAR</button><button type="button" data-action="save-original">SAVE ORIGINAL</button><button type="button" data-action="save-marked">SAVE MARKED</button><button type="button" data-action="enhance">ENHANCE REGION (LOCAL)</button><button type="button" data-action="ask">ASK AI</button></div><section class="snapshot-enhance" hidden><h3 tabindex="-1">Local region enhancement</h3><p>Choose an area, then click Apply. This runs on your device: crop, zoom, contrast and sharpening only. No AI generation or upload. It cannot recover missing details or prove a make/model/year.</p><p class="snapshot-enhance-selection"></p><div class="snapshot-tools"><button type="button" data-action="apply-enhance" disabled>APPLY LOCAL ENHANCEMENT</button><button type="button" data-action="select-enhance">SELECT AREA</button><button type="button" data-action="cancel-enhance" disabled>CANCEL ENHANCEMENT</button><button type="button" data-action="reset-enhance">RESET ENHANCEMENT</button></div><p class="snapshot-enhance-status" role="status" aria-live="polite"></p><progress class="snapshot-enhance-progress" max="100" value="0" aria-label="Local enhancement progress" hidden></progress><canvas class="snapshot-enhance-source-preview" aria-label="Original selected area preview" hidden></canvas><div class="snapshot-enhance-result" hidden><h4 tabindex="-1">Local enhancement result</h4><p class="snapshot-enhance-result-caption"></p><canvas class="snapshot-enhanced-canvas" aria-label="Local enhanced result or original comparison"></canvas><div class="snapshot-tools"><button type="button" data-action="compare" disabled>COMPARE ORIGINAL AREA</button><button type="button" data-action="save-enhanced" disabled>SAVE ENHANCED PNG</button></div></div><label>Optional research note (unverified hypothesis)<textarea class="snapshot-note" maxlength="1500" rows="2" placeholder="Your tentative description or research notes"></textarea></label><p>Notes are saved separately. They do not change pixels or control enhancement.</p><button type="button" data-action="use-description">USE SUGGESTED DESCRIPTION</button><button type="button" data-action="save-note">SAVE NOTE</button></section><section class="snapshot-ai" hidden><h3 tabindex="-1">Ask about this snapshot</h3><p class="snapshot-ai-selection"></p><canvas class="snapshot-ai-preview" aria-label="Selected original area preview for AI guidance" hidden></canvas><p class="snapshot-ai-evidence">Sending uploads the full unchanged ORIGINAL. For a selected area, the server also sends a lossless crop of those same original pixels plus mark coordinates as focus guidance. No red marks, enhanced pixels or AI reconstructions are sent as evidence.</p><div class="snapshot-suggestions"></div><label>Your question<textarea class="snapshot-question" maxlength="2000" rows="3" placeholder="Ask about the selected object or visible details"></textarea></label><p class="snapshot-model"></p><p>Vehicle make/model may be unknown. Any confidence percentage is a model self-estimate, not validated accuracy. No person or plate identification or cross-camera matching.</p><button type="button" data-action="send">SEND ORIGINAL TO SOL</button><button type="button" data-action="cancel-send">CANCEL REQUEST</button><p class="snapshot-ai-status" role="status" aria-live="polite"></p><pre class="snapshot-answer" tabindex="-1"></pre></section><p class="snapshot-status" role="status" aria-live="polite"></p>`;
    this.doc.body.append(this.dialog);
    this.canvas = this.dialog.querySelector('.snapshot-canvas');
    this.bindTouchActivation(this.dialog);
    this.bindTouchActivation(this.button);
    this.enhancedCanvas = this.dialog.querySelector(
      '.snapshot-enhanced-canvas',
    );
    const reconstructionButton = this.doc.createElement('button');
    reconstructionButton.type = 'button';
    reconstructionButton.dataset.action = 'open-generate';
    reconstructionButton.textContent = 'AI RECONSTRUCTION';
    this.dialog.querySelector('.snapshot-tools').append(reconstructionButton);
    this.reconstruction = new CameraReconstructionUI(this);
    for (const text of [
      'What year range, make and model are plausible?',
      'Describe its color and body style',
      'What visible details support that answer?',
    ]) {
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.textContent = text;
      this.dialog.querySelector('.snapshot-suggestions').append(b);
      this.listen(b, 'click', () => {
        this.dialog.querySelector('.snapshot-question').value = text;
        this.invalidateAiAnswer(
          'Question changed. Send again to get an answer for this question.',
        );
      });
    }
    this.listen(button, 'click', () => void this.capture());
    this.listen(this.dialog.querySelector('.snapshot-question'), 'input', () =>
      this.invalidateAiAnswer(
        'Question changed. Send again to get an answer for this question.',
      ),
    );
    this.listen(
      this.dialog,
      'click',
      (e) =>
        void this.action(
          e.target.closest?.('[data-action]')?.dataset.action,
        ).catch(() =>
          this.status('The local action failed. Your original is unchanged.'),
        ),
    );
    this.listen(this.dialog, 'cancel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.listen(this.dialog, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.listen(this.canvas, 'pointerdown', (e) => {
      if (
        !this.original ||
        this.pending ||
        this.reconstruction?.pending ||
        this.activeStroke ||
        (e.button !== 0 && e.pointerType !== 'touch')
      )
        return;
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.pointerId = e.pointerId;
      this.activeStroke = {
        mode: this.mode,
        points: [imagePoint(e, this.canvas.getBoundingClientRect())],
      };
      this.render();
    });
    this.listen(this.canvas, 'pointermove', (e) => {
      if (!this.activeStroke || e.pointerId !== this.pointerId) return;
      const p = imagePoint(e, this.canvas.getBoundingClientRect());
      if (this.mode === 'marker') {
        if (this.activeStroke.points.length < 300)
          this.activeStroke.points.push(p);
      } else this.activeStroke.points[1] = p;
      this.render();
    });
    this.listen(this.canvas, 'pointerup', (e) => {
      if (!this.activeStroke || e.pointerId !== this.pointerId) return;
      if (this.strokes.length < 50) this.strokes.push(this.activeStroke);
      this.activeStroke = null;
      this.pointerId = null;
      this.render();
      this.syncSelection();
    });
    this.listen(this.canvas, 'pointercancel', () => {
      this.activeStroke = null;
      this.pointerId = null;
      this.render();
    });
  }
  listen(target, type, fn) {
    target.addEventListener(type, fn, { signal: this.listeners.signal });
  }
  cancelTouchActivation() {
    clearTimeout(this.touchPending?.timer);
    this.touchPending = null;
    this.touchPress = null;
  }
  /** Keep semantic click/keyboard activation; recover a touch tap that emits no click. */
  bindTouchActivation(root) {
    this.listen(root, 'pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.cancelTouchActivation();
      const button = e.target.closest?.('button');
      if (button && root.contains(button) && !button.disabled)
        this.touchPress = {
          button,
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
        };
    });
    this.listen(root, 'pointercancel', () => this.cancelTouchActivation());
    this.listen(root, 'pointermove', (e) => {
      const press = this.touchPress;
      if (
        press &&
        e.pointerId === press.pointerId &&
        Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10
      )
        this.cancelTouchActivation();
    });
    this.listen(root, 'pointerup', (e) => {
      const press = this.touchPress;
      this.touchPress = null;
      if (
        !press ||
        e.pointerType !== 'touch' ||
        e.pointerId !== press.pointerId ||
        e.target.closest?.('button') !== press.button ||
        Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10
      )
        return;
      const pending = { button: press.button };
      this.touchPending = pending;
      pending.timer = setTimeout(() => {
        if (
          this.touchPending !== pending ||
          this.destroyed ||
          !pending.button.isConnected ||
          pending.button.disabled
        )
          return;
        this.touchPending = null;
        this.touchFallbacks.set(pending.button, performance.now());
        pending.button.click();
      }, 50);
    });
    const captureClick = (e) => {
      const button = e.target.closest?.('button');
      const fallbackAt = button && this.touchFallbacks.get(button);
      if (
        e.isTrusted &&
        e.detail > 0 &&
        fallbackAt !== undefined &&
        performance.now() - fallbackAt < 700
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (this.touchPending?.button === button) this.cancelTouchActivation();
    };
    root.addEventListener('click', captureClick, {
      capture: true,
      signal: this.listeners.signal,
    });
  }
  status(text, section) {
    this.dialog.querySelector('.snapshot-status').textContent = text;
    if (section)
      this.dialog.querySelector(`.snapshot-${section}-status`).textContent =
        text;
  }
  reveal(selector) {
    const target = this.dialog.querySelector(selector);
    target?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
    target?.focus?.({ preventScroll: true });
  }
  getSelection() {
    return snapshotSelection(
      this.strokes,
      this.original?.width,
      this.original?.height,
    );
  }
  drawSelectionPreview(canvas, selection) {
    canvas.hidden = !selection;
    if (!selection) return;
    const b = selection.pixelBounds,
      scale = Math.min(1, 320 / b.width, 240 / b.height);
    canvas.width = Math.max(1, Math.round(b.width * scale));
    canvas.height = Math.max(1, Math.round(b.height * scale));
    canvas
      .getContext('2d')
      .drawImage(
        this.original,
        b.x,
        b.y,
        b.width,
        b.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
  }
  syncSelection() {
    const selection = this.getSelection(),
      key = JSON.stringify(selection);
    if (key !== this.selectionKey) {
      this.invalidateAiAnswer(
        'Selected area changed. Send again for the current target.',
      );
      this.cancelEnhancement(false);
      this.derivative = this.regionOriginal = null;
      this.dialog.querySelector('.snapshot-enhance-result').hidden = true;
      this.selectionKey = key;
      if (!this.dialog.querySelector('.snapshot-enhance').hidden)
        this.status(
          selection
            ? 'Selected area ready. Click APPLY LOCAL ENHANCEMENT to create a result.'
            : 'Draw a circle, rectangle or marker area on the snapshot first.',
          'enhance',
        );
    }
    const description = selection
      ? `Selected area: ${selection.mode} ${selection.markIndex + 1}, ${selection.pixelBounds.width} × ${selection.pixelBounds.height} source pixels. The latest valid mark sets the focus; circles and drawings use their bounding rectangle.`
      : this.strokes.length
        ? 'No usable area selected. Draw an area at least 3 × 3 source pixels. AI can still examine the full original with your marks.'
        : 'No area selected. Draw a circle, rectangle or marker area to focus on it. Ask AI can also examine the whole snapshot.';
    this.dialog.querySelector('.snapshot-selection-summary').textContent =
      description;
    this.dialog.querySelector('.snapshot-enhance-selection').textContent =
      selection
        ? `Selected original crop: ${selection.pixelBounds.width} × ${selection.pixelBounds.height} pixels, from your latest ${selection.mode} area.`
        : 'No area selected. Choose SELECT AREA and drag on the original snapshot.';
    this.dialog.querySelector('.snapshot-ai-selection').textContent = selection
      ? description
      : 'Analysis target: whole snapshot. No usable area is selected.';
    this.dialog.querySelector('.snapshot-ai h3').textContent = selection
      ? 'Ask about the selected area'
      : 'Ask about the whole snapshot';
    this.dialog.querySelector('[data-action="send"]').textContent = selection
      ? 'SEND ORIGINAL + SELECTED AREA GUIDANCE'
      : 'SEND WHOLE SNAPSHOT TO SOL';
    this.drawSelectionPreview(
      this.dialog.querySelector('.snapshot-ai-preview'),
      selection,
    );
    this.drawSelectionPreview(
      this.dialog.querySelector('.snapshot-enhance-source-preview'),
      selection,
    );
    this.syncEnhancementControls();
    this.syncAiControls();
    this.reconstruction?.syncTarget();
  }
  syncAiControls() {
    this.dialog.querySelector('[data-action="send"]').disabled =
      this.pending || typeof this.ai?.ask !== 'function';
    for (const action of ['marker', 'circle', 'region', 'undo', 'clear'])
      this.dialog.querySelector(`[data-action="${action}"]`).disabled =
        !!this.pending || !!this.reconstruction?.pending;
    this.dialog.querySelector('.snapshot-question').disabled = !!this.pending;
    for (const button of this.dialog.querySelectorAll(
      '.snapshot-suggestions button',
    ))
      button.disabled = !!this.pending;
  }
  invalidateAiAnswer(message) {
    const answer = this.dialog.querySelector('.snapshot-answer'),
      request = this.request;
    const hadAnswer = !!answer.textContent;
    request?.abort();
    this.request = null;
    this.pending = false;
    answer.textContent = '';
    if (request || hadAnswer)
      this.status(
        request
          ? message +
              ' Previous request canceled; a sent image cannot be recalled.'
          : message,
        'ai',
      );
    this.syncAiControls();
  }
  syncEnhancementControls() {
    const busy = !!this.enhancementRequest;
    this.dialog.querySelector('[data-action="apply-enhance"]').disabled =
      busy || !this.getSelection();
    this.dialog.querySelector('[data-action="cancel-enhance"]').disabled =
      !busy;
    for (const action of ['compare', 'save-enhanced'])
      this.dialog.querySelector(`[data-action="${action}"]`).disabled =
        busy || !this.derivative;
    this.dialog
      .querySelector('.snapshot-enhance')
      .setAttribute('aria-busy', String(busy));
    this.dialog.querySelector('.snapshot-enhance-progress').hidden = !busy;
  }
  cancelEnhancement(feedback = true) {
    const request = this.enhancementRequest;
    request?.abort();
    this.enhancementRequest = null;
    if (request && feedback)
      this.status(
        'Local enhancement canceled. No new result was applied; the original is unchanged.',
        'enhance',
      );
    if (this.dialog) this.syncEnhancementControls();
  }
  async capture() {
    if (this.busy || this.destroyed) return;
    this.cancelEnhancement();
    this.busy = true;
    const epoch = ++this.epoch;
    try {
      const state = this.readState(),
        camera = state?.activeCamera;
      const decoded = this.getVideo();
      const source =
        !this.video?.hidden &&
        decoded?.readyState >= 2 &&
        decoded.videoWidth > 1 &&
        decoded.videoHeight > 1 &&
        camera?.connection?.status === 'ready'
          ? decoded
          : this.video?.hidden &&
              this.image?.classList.contains('active') &&
              this.image.complete &&
              this.image.dataset.cameraId === String(camera?.id || '')
            ? this.image
            : null;
      if (!state?.enabled || !camera || !source)
        throw new Error(
          'Camera pixels are not available yet. Wait for a displayed frame.',
        );
      const width = source.videoWidth || source.naturalWidth || source.width,
        height = source.videoHeight || source.naturalHeight || source.height;
      if (!width || !height)
        throw new Error('The displayed frame is unavailable.');
      const scale = Math.min(1, 1920 / width, 1080 / height),
        c = this.doc.createElement('canvas');
      c.width = Math.max(1, Math.round(width * scale));
      c.height = Math.max(1, Math.round(height * scale)) + 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#07121b';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(source, 0, 0, c.width, c.height - 64);
      const capturedAt = new Date(),
        cameraId = camera.id || state.activeCameraId;
      const caption = `${camera.name || cameraId} | ${camera.provider || state.source || 'Camera source'} | Captured ${capturedAt.toISOString()} (viewing device clock)${scale < 1 ? ' | Resolution capped to 1920×1080' : ''}`;
      ctx.fillStyle = '#e9f8ff';
      ctx.font = '14px sans-serif';
      ctx.fillText(caption.slice(0, 180), 10, c.height - 40, c.width - 20);
      ctx.fillText(
        'Personal snapshot; original frame preserved. Capture time is not the provider frame timestamp.',
        10,
        c.height - 17,
        c.width - 20,
      );
      const blob = await this.blob(c);
      if (epoch !== this.epoch || this.destroyed) return;
      this.capturedAt = capturedAt;
      this.cameraId = cameraId;
      this.caption = caption;
      this.original = c;
      this.originalBlob = blob;
      this.frameHeight = c.height - 64;
      this.reconstruction.reset();
      this.cancelEnhancement(false);
      this.ai = null;
      this.strokes = [];
      this.activeStroke = null;
      this.derivative = null;
      this.regionOriginal = null;
      this.dialog.querySelector('.snapshot-note').value = '';
      this.dialog.querySelector('.snapshot-question').value = '';
      this.canvas.width = c.width;
      this.canvas.height = c.height;
      this.render();
      this.dialog.querySelector('.snapshot-caption').textContent = this.caption;
      this.dialog.querySelector('.snapshot-ai').hidden = true;
      this.dialog.querySelector('.snapshot-enhance').hidden = true;
      this.dialog.querySelector('.snapshot-answer').textContent = '';
      this.dialog.querySelector('.snapshot-ai-status').textContent = '';
      this.dialog.querySelector('.snapshot-enhance-result').hidden = true;
      this.selectionKey = undefined;
      this.syncSelection();
      const parent = this.doc.fullscreenElement || this.doc.body;
      if (this.dialog.parentNode !== parent) parent.append(this.dialog);
      if (!this.dialog.open) this.dialog.showModal();
      this.download(blob, snapshotFilename(this.cameraId, this.capturedAt));
      this.status(
        'Snapshot download requested on this device. Browser download settings may ask where to save. No image has been uploaded.',
      );
    } catch (e) {
      this.showToast(
        e.name === 'SecurityError'
          ? 'This camera blocks pixel export (CORS). Snapshot was not saved.'
          : e.message || 'Snapshot could not be saved.',
      );
    } finally {
      this.busy = false;
    }
  }
  blob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Image encoding failed.'))),
          'image/png',
        );
      } catch (e) {
        reject(e);
      }
    });
  }
  download(blob, name) {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    const a = this.doc.createElement('a');
    a.href = url;
    a.download = name;
    this.doc.body.append(a);
    a.click();
    a.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
      this.downloadTimers.delete(timer);
    }, 30000);
    this.downloadTimers.add(timer);
  }
  render() {
    if (!this.original) return;
    const c = this.canvas,
      ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.original, 0, 0);
    ctx.strokeStyle = '#ff4242';
    ctx.lineWidth = Math.max(3, c.width / 320);
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const s of [
      ...this.strokes,
      ...(this.activeStroke ? [this.activeStroke] : []),
    ]) {
      ctx.beginPath();
      if (s.mode === 'marker') {
        s.points.forEach((p, i) =>
          ctx[i ? 'lineTo' : 'moveTo'](p.x * c.width, p.y * c.height),
        );
      } else {
        const b = regionBounds(s.points);
        if (s.mode === 'circle')
          ctx.ellipse(
            (b.x + b.w / 2) * c.width,
            (b.y + b.h / 2) * c.height,
            (b.w * c.width) / 2,
            (b.h * c.height) / 2,
            0,
            0,
            Math.PI * 2,
          );
        else
          ctx.rect(
            b.x * c.width,
            b.y * c.height,
            b.w * c.width,
            b.h * c.height,
          );
      }
      ctx.stroke();
    }
  }
  enhance() {
    this.dialog.querySelector('.snapshot-enhance').hidden = false;
    this.syncSelection();
    this.status(
      this.getSelection()
        ? 'Selected original area preview. Click APPLY LOCAL ENHANCEMENT to create a result.'
        : 'Draw a circle, rectangle or marker area first, then click Apply.',
      'enhance',
    );
    this.reveal('.snapshot-enhance h3');
  }
  async applyEnhancement() {
    if (this.enhancementRequest || !this.original) return;
    const selection = this.getSelection();
    if (!selection) {
      this.status(
        'Draw an area at least 3 × 3 source pixels before applying enhancement.',
        'enhance',
      );
      this.reveal('.snapshot-enhance h3');
      return;
    }
    const controller = new AbortController(),
      epoch = this.epoch,
      key = this.selectionKey;
    this.enhancementRequest = controller;
    this.dialog.querySelector('.snapshot-enhance-progress').value = 0;
    this.status(
      'Applying local crop, zoom, contrast and sharpening… No image is uploaded.',
      'enhance',
    );
    this.syncEnhancementControls();
    this.reveal('[data-action="apply-enhance"]');
    try {
      const { x: sx, y: sy, width: sw, height: sh } = selection.pixelBounds,
        src = this.original;
      const c = this.doc.createElement('canvas'),
        scale = Math.min(720 / sw, 720 / sh, 4);
      c.width = Math.max(1, Math.round(sw * scale));
      c.height = Math.max(1, Math.round(sh * scale));
      const ctx = c.getContext('2d');
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const pixels = ctx.getImageData(0, 0, c.width, c.height);
      pixels.data.set(
        await this.enhancePixels(pixels.data, c.width, c.height, {
          signal: controller.signal,
          progress: (value) => {
            if (this.enhancementRequest === controller) {
              this.dialog.querySelector('.snapshot-enhance-progress').value =
                value;
              this.status(`Applying local enhancement: ${value}%`, 'enhance');
            }
          },
        }),
      );
      if (
        controller.signal.aborted ||
        this.enhancementRequest !== controller ||
        epoch !== this.epoch ||
        key !== this.selectionKey
      )
        return;
      const enhanced = this.doc.createElement('canvas');
      enhanced.width = c.width;
      enhanced.height = c.height;
      enhanced.getContext('2d').putImageData(pixels, 0, 0);
      this.derivative = enhanced;
      this.regionOriginal = c;
      this.comparing = false;
      this.showEnhance();
      this.status(
        'Local enhancement applied. Result shown below; compare it with the original area or save a separate PNG. Original unchanged.',
        'enhance',
      );
      this.reveal('.snapshot-enhance-result h4');
    } catch (e) {
      if (this.enhancementRequest === controller)
        this.status(
          e.name === 'AbortError'
            ? 'Local enhancement canceled. Original unchanged.'
            : 'Local enhancement failed. Your original and any prior result are unchanged. Try applying again.',
          'enhance',
        );
    } finally {
      if (this.enhancementRequest === controller) {
        this.enhancementRequest = null;
        this.syncEnhancementControls();
      }
    }
  }
  showEnhance() {
    const s = this.comparing ? this.regionOriginal : this.derivative;
    if (!s) return;
    this.enhancedCanvas.width = s.width;
    this.enhancedCanvas.height = s.height;
    this.enhancedCanvas.getContext('2d').drawImage(s, 0, 0);
    this.dialog.querySelector('.snapshot-enhance-result').hidden = false;
    this.dialog.querySelector('.snapshot-enhance-result h4').textContent = this
      .comparing
      ? 'Original selected area — comparison'
      : 'Local enhancement result';
    this.dialog.querySelector('.snapshot-enhance-result-caption').textContent =
      this.comparing
        ? 'Unfiltered original area, at the same display size. Your full original remains unchanged.'
        : `${s.width} × ${s.height} derivative: crop/zoom/contrast/sharpening only. No generated or recovered detail.`;
    this.dialog.querySelector('[data-action="compare"]').textContent = this
      .comparing
      ? 'SHOW ENHANCED'
      : 'COMPARE ORIGINAL AREA';
  }
  async action(action) {
    if (!action || this.destroyed) return;
    if (
      [
        'open-generate',
        'generate',
        'cancel-generate',
        'reset-generation',
        'save-generated',
      ].includes(action)
    )
      return this.reconstruction.action(action);
    if (action === 'close') return this.close();
    if (['marker', 'circle', 'region'].includes(action)) {
      this.mode = action;
      for (const b of this.dialog.querySelectorAll('[aria-pressed]'))
        b.setAttribute('aria-pressed', String(b.dataset.action === action));
      return;
    }
    if (action === 'undo') this.strokes.pop();
    if (action === 'clear') this.strokes = [];
    if (['undo', 'clear'].includes(action)) {
      this.activeStroke = null;
      this.render();
      this.syncSelection();
      return;
    }
    if (action === 'enhance') return this.enhance();
    if (action === 'apply-enhance') return this.applyEnhancement();
    if (action === 'cancel-enhance') return this.cancelEnhancement();
    if (action === 'select-enhance') {
      await this.action('region');
      this.status(
        'Drag a rectangle on the original snapshot, then return to APPLY LOCAL ENHANCEMENT.',
        'enhance',
      );
      this.reveal('.snapshot-canvas');
      return;
    }
    if (action === 'compare') {
      this.comparing = !this.comparing;
      return this.showEnhance();
    }
    if (action === 'reset-enhance') {
      this.cancelEnhancement(false);
      this.derivative = null;
      this.regionOriginal = null;
      this.comparing = false;
      this.dialog.querySelector('.snapshot-enhance-result').hidden = true;
      this.syncEnhancementControls();
      this.status(
        'Enhancement reset. The selected original area and research note remain; click Apply for a new result.',
        'enhance',
      );
      this.reveal('.snapshot-enhance h3');
      return;
    }
    if (action === 'save-original' && this.originalBlob)
      return this.download(
        this.originalBlob,
        snapshotFilename(this.cameraId, this.capturedAt),
      );
    if (action === 'save-marked' && this.original) {
      const filename = snapshotFilename(this.cameraId, this.capturedAt).replace(
        '.png',
        '-marked.png',
      );
      return this.download(await this.blob(this.canvas), filename);
    }
    if (action === 'save-enhanced' && this.derivative) {
      const filename = snapshotFilename(this.cameraId, this.capturedAt).replace(
        '.png',
        '-enhanced-derivative.png',
      );
      this.status('Preparing the enhanced PNG download…', 'enhance');
      try {
        this.download(await this.blob(this.derivative), filename);
        this.status(
          'Enhanced PNG download requested. It is a separate derivative; your original is unchanged.',
          'enhance',
        );
      } catch {
        this.status(
          'Enhanced PNG export failed. The original and local result remain available; try saving again.',
          'enhance',
        );
      }
      return;
    }
    if (action === 'use-description') {
      const text = this.dialog.querySelector('.snapshot-answer').textContent;
      if (text)
        this.dialog.querySelector('.snapshot-note').value =
          'Unverified AI hypothesis: ' + text.slice(0, 1400);
      else
        this.status(
          'No AI description is available. You can enter your own unverified research note.',
        );
      return;
    }
    if (action === 'save-note') {
      const text = this.dialog.querySelector('.snapshot-note').value;
      return this.download(
        new Blob(
          [
            'UNVERIFIED RESEARCH HYPOTHESIS; NOT GROUND TRUTH' +
              String.fromCharCode(10) +
              this.caption +
              String.fromCharCode(10) +
              text,
          ],
          { type: 'text/plain' },
        ),
        snapshotFilename(this.cameraId, this.capturedAt).replace(
          '.png',
          '-research-note.txt',
        ),
      );
    }
    if (action === 'ask') {
      this.dialog.querySelector('.snapshot-ai').hidden = false;
      this.ai = null;
      this.syncSelection();
      this.status(
        this.getSelection()
          ? 'Selected area confirmed below. Enter a question, then send the original plus selected-area guidance.'
          : 'No area selected: AI will examine the whole original snapshot.',
        'ai',
      );
      this.reveal('.snapshot-ai h3');
      this.dialog.querySelector('[data-action="send"]').disabled = true;
      this.dialog.querySelector('.snapshot-model').textContent =
        'Checking existing OpenAI image access… No image is sent by this check.';
      const epoch = this.epoch;
      this.capabilityController?.abort();
      const capability = new AbortController();
      this.capabilityController = capability;
      let ai;
      try {
        ai = await this.readAi(capability.signal);
      } catch (e) {
        ai = {
          error:
            e.name === 'AbortError'
              ? 'Capability check canceled.'
              : 'Existing OpenAI image access could not be verified.',
        };
      }
      if (
        epoch !== this.epoch ||
        capability.signal.aborted ||
        this.capabilityController !== capability
      )
        return;
      this.ai = ai;
      this.dialog.querySelector('.snapshot-model').textContent =
        `OpenAI model: ${ai?.model || 'Unavailable'}${ai?.ask ? ' reasoning: ' + (ai.reasoning || 'Unavailable') : ''}. ${ai?.access || ''} ${ai?.warning || ai?.error || 'No image-capable connection available.'} Existing server credential only; no new connection or key will be created.`;
      this.dialog.querySelector('[data-action="send"]').disabled =
        typeof ai?.ask !== 'function';
      this.syncAiControls();
      if (typeof ai?.ask !== 'function')
        this.status(
          'Snapshot is saved. Single-image Q&A is unavailable in the current AI connection; no upload has occurred.',
          'ai',
        );
      return;
    }
    if (action === 'cancel-send') {
      this.capabilityController?.abort();
      this.capabilityController = null;
      this.request?.abort();
      this.request = null;
      this.pending = false;
      this.syncAiControls();
      this.status(
        'Request canceled. An image already sent to OpenAI cannot be recalled.',
        'ai',
      );
      return;
    }
    if (action === 'send') return this.send();
  }
  async send() {
    if (this.pending || !this.original) return;
    const ai = this.ai,
      question = this.dialog.querySelector('.snapshot-question').value.trim();
    if (!question) {
      this.status('Enter a question first.', 'ai');
      this.reveal('.snapshot-question');
      return;
    }
    if (typeof ai?.ask !== 'function') {
      this.status(
        'No existing image-capable OpenAI connection is available. Nothing was uploaded.',
        'ai',
      );
      return;
    }
    const epoch = this.epoch;
    this.pending = true;
    this.syncAiControls();
    this.dialog.querySelector('.snapshot-answer').textContent = '';
    const selection = this.getSelection();
    const request = new AbortController();
    this.request = request;
    this.status(
      selection
        ? 'Asking Sol about the selected area. Uploading the unchanged original and mark/area coordinates; enhanced pixels are excluded.'
        : 'Asking Sol about the whole original snapshot. Enhanced pixels are excluded.',
      'ai',
    );
    try {
      const answer = await ai.ask({
        original: this.original,
        question,
        marks: this.strokes.map((s) => ({
          mode: s.mode,
          points: s.points.map((p) => ({ x: p.x, y: p.y })),
        })),
        focus: selection ? 'selected-region' : 'whole-frame',
        selectedRegion: selection,
        signal: request.signal,
      });
      if (
        epoch === this.epoch &&
        this.request === request &&
        !request.signal.aborted
      ) {
        this.dialog.querySelector('.snapshot-answer').textContent =
          String(answer);
        this.status(
          'OpenAI answer received. Treat identification as a hypothesis; verify visible details against the original.',
          'ai',
        );
        this.reveal('.snapshot-answer');
      }
    } catch (e) {
      if (epoch === this.epoch && this.request === request)
        this.status(
          e.name === 'AbortError'
            ? 'Request canceled. An image already sent to OpenAI cannot be recalled.'
            : `${e.message || 'OpenAI image Q&A failed.'} Your saved original is unchanged.`,
          'ai',
        );
    } finally {
      if (this.request === request) {
        this.pending = false;
        this.request = null;
        this.syncAiControls();
      }
    }
  }
  close() {
    this.cancelTouchActivation();
    this.reconstruction?.cancel(false);
    this.reconstruction?.lookup?.abort();
    this.cancelEnhancement(false);
    this.epoch++;
    this.request?.abort();
    this.request = null;
    this.capabilityController?.abort();
    this.capabilityController = null;
    this.ai = null;
    this.pending = false;
    this.activeStroke = null;
    if (this.dialog?.open) this.dialog.close();
    this.button?.focus?.({ preventScroll: true });
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close();
    this.listeners.abort();
    this.dialog?.remove();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls.clear();
    for (const timer of this.downloadTimers) clearTimeout(timer);
    this.downloadTimers.clear();
    this.original =
      this.originalBlob =
      this.derivative =
      this.regionOriginal =
        null;
  }
}

/** Local, user-triggered camera capture and pixel-preserving annotation. */
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
    this.dialog.innerHTML = `<header><h2 id="snapshot-title">Camera snapshot</h2><button type="button" data-action="close" aria-label="Close snapshot preview">CLOSE</button></header><p class="snapshot-caption"></p><canvas class="snapshot-canvas" aria-label="Snapshot annotation canvas"></canvas><div class="snapshot-tools"><button type="button" data-action="marker" aria-pressed="true">MARKER</button><button type="button" data-action="circle" aria-pressed="false">CIRCLE</button><button type="button" data-action="region" aria-pressed="false">REGION</button><button type="button" data-action="undo">UNDO</button><button type="button" data-action="clear">CLEAR</button><button type="button" data-action="save-original">SAVE ORIGINAL</button><button type="button" data-action="save-marked">SAVE MARKED</button><button type="button" data-action="enhance">ENHANCE REGION</button><button type="button" data-action="ask">ASK AI</button></div><section class="snapshot-enhance" hidden><h3>Non-generative region enhancement</h3><p>Crop, zoom, contrast and sharpening change the display. They cannot recover missing details or prove a make, model or year.</p><div class="snapshot-tools"><button type="button" data-action="compare">COMPARE ORIGINAL</button><button type="button" data-action="reset-enhance">RESET</button><button type="button" data-action="save-enhanced">SAVE DERIVATIVE</button></div><canvas class="snapshot-enhanced-canvas" aria-label="Enhanced region comparison"></canvas><label>Research note (unverified hypothesis)<textarea class="snapshot-note" maxlength="1500" rows="2" placeholder="Your tentative description or research notes"></textarea></label><p>This note does not alter pixels or turn a hypothesis into evidence.</p><button type="button" data-action="use-description">USE SUGGESTED DESCRIPTION</button><button type="button" data-action="save-note">SAVE NOTE</button></section><section class="snapshot-ai" hidden><h3>Ask about this snapshot</h3><div class="snapshot-suggestions"></div><label>Your question<textarea class="snapshot-question" maxlength="2000" rows="3" placeholder="Describe the object or visible details you want to understand"></textarea></label><p>Send the ORIGINAL snapshot to OpenAI for factual analysis. Marker/circle coordinates may be included as guidance. Enhanced pixels are never sent as evidence.</p><p class="snapshot-model"></p><p>Vehicle make/model may be unknown. Any confidence percentage is a model self-estimate, not validated accuracy. No person or plate identification or cross-camera matching.</p><button type="button" data-action="send">SEND ORIGINAL TO OPENAI</button><button type="button" data-action="cancel-send">CANCEL REQUEST</button><pre class="snapshot-answer"></pre></section><p class="snapshot-status" role="status" aria-live="polite"></p>`;
    this.doc.body.append(this.dialog);
    this.canvas = this.dialog.querySelector('.snapshot-canvas');
    this.bindTouchActivation(this.dialog);
    this.bindTouchActivation(this.button);
    this.enhancedCanvas = this.dialog.querySelector(
      '.snapshot-enhanced-canvas',
    );
    for (const text of [
      'What make/model might this be?',
      'Describe its color and body style',
      'What visible details support that answer?',
    ]) {
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.textContent = text;
      this.dialog.querySelector('.snapshot-suggestions').append(b);
      this.listen(b, 'click', () => {
        this.dialog.querySelector('.snapshot-question').value = text;
      });
    }
    this.listen(button, 'click', () => void this.capture());
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
  status(text) {
    this.dialog.querySelector('.snapshot-status').textContent = text;
  }
  async capture() {
    if (this.busy || this.destroyed) return;
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
    const s = this.strokes.at(-1);
    if (!s) {
      this.status('Mark or select a region first.');
      return;
    }
    const b = regionBounds(s.points),
      src = this.original,
      sx = Math.floor(b.x * src.width),
      sy = Math.floor(b.y * src.height),
      sw = Math.max(1, Math.floor(b.w * src.width)),
      sh = Math.max(1, Math.floor(b.h * src.height));
    if (sw < 3 || sh < 3) {
      this.status('Select a larger region.');
      return;
    }
    const c = this.doc.createElement('canvas'),
      scale = Math.min(720 / sw, 720 / sh, 4);
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    const ctx = c.getContext('2d');
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    this.regionOriginal = c;
    const pixels = ctx.getImageData(0, 0, c.width, c.height),
      copy = new Uint8ClampedArray(pixels.data);
    for (let y = 1; y < c.height - 1; y++)
      for (let x = 1; x < c.width - 1; x++) {
        const i = (y * c.width + x) * 4;
        for (let k = 0; k < 3; k++) {
          const sharp =
            1.8 * copy[i + k] -
            0.2 *
              (copy[i - 4 + k] +
                copy[i + 4 + k] +
                copy[i - c.width * 4 + k] +
                copy[i + c.width * 4 + k]);
          pixels.data[i + k] = (sharp - 128) * 1.15 + 128;
        }
      }
    const enhanced = this.doc.createElement('canvas');
    enhanced.width = c.width;
    enhanced.height = c.height;
    enhanced.getContext('2d').putImageData(pixels, 0, 0);
    this.derivative = enhanced;
    this.comparing = false;
    this.showEnhance();
    this.dialog.querySelector('.snapshot-enhance').hidden = false;
    this.status(
      'Enhanced derivative: crop, zoom, contrast and sharpening only. Original remains unchanged.',
    );
  }
  showEnhance() {
    const s = this.comparing ? this.regionOriginal : this.derivative;
    if (!s) return;
    this.enhancedCanvas.width = s.width;
    this.enhancedCanvas.height = s.height;
    this.enhancedCanvas.getContext('2d').drawImage(s, 0, 0);
    this.dialog.querySelector('[data-action="compare"]').textContent = this
      .comparing
      ? 'SHOW ENHANCED'
      : 'COMPARE ORIGINAL';
  }
  async action(action) {
    if (!action || this.destroyed) return;
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
      return;
    }
    if (action === 'enhance') return this.enhance();
    if (action === 'compare') {
      this.comparing = !this.comparing;
      return this.showEnhance();
    }
    if (action === 'reset-enhance') {
      this.derivative = null;
      this.regionOriginal = null;
      this.dialog.querySelector('.snapshot-enhance').hidden = true;
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
      return this.download(await this.blob(this.derivative), filename);
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
      if (typeof ai?.ask !== 'function')
        this.status(
          'Snapshot is saved. Single-image Q&A is unavailable in the current AI connection; no upload has occurred.',
        );
      return;
    }
    if (action === 'cancel-send') {
      this.capabilityController?.abort();
      this.capabilityController = null;
      this.request?.abort();
      this.request = null;
      this.pending = false;
      this.status(
        'Request canceled. An image already sent to OpenAI cannot be recalled.',
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
      this.status('Enter a question first.');
      return;
    }
    if (typeof ai?.ask !== 'function') {
      this.status(
        'No existing image-capable OpenAI connection is available. Nothing was uploaded.',
      );
      return;
    }
    const epoch = this.epoch;
    this.pending = true;
    const request = new AbortController();
    this.request = request;
    this.status(
      'Sending the original snapshot and question to OpenAI. Enhanced pixels are excluded.',
    );
    try {
      const answer = await ai.ask({
        original: this.original,
        question,
        marks: this.strokes.map((s) => ({ mode: s.mode, points: s.points })),
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
        );
      }
    } catch (e) {
      if (epoch === this.epoch && this.request === request)
        this.status(
          e.name === 'AbortError'
            ? 'Request canceled. An image already sent to OpenAI cannot be recalled.'
            : `${e.message || 'OpenAI image Q&A failed.'} Your saved original is unchanged.`,
        );
    } finally {
      if (this.request === request) {
        this.pending = false;
        this.request = null;
      }
    }
  }
  close() {
    this.cancelTouchActivation();
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

/** Shortest-wrap signed degrees, for heading offsets typed as absolute values. */
const signedNormalizeDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

/**
 * Field definitions for the CCTV click-to-edit pose readout. Chips DISPLAY the
 * camera's EFFECTIVE pose (not raw offsets — "HDG 135.0°" instead of the old
 * "HEADING 0°" nonsense); typed values convert back to calibration offsets
 * against the frozen basePose. ΔN/ΔE stay offset-denominated (absolute lat/lon
 * typing is user-hostile).
 */
const CCTV_CAL_FIELDS = {
  heading: {
    label: 'HDG',
    unit: '°',
    decimals: 1,
    get: (cam) => cam.headingDeg,
    toPatch: (value, base) => ({
      headingDeg: signedNormalizeDeg(value - base.headingDeg),
    }),
  },
  pitch: {
    label: 'PITCH',
    unit: '°',
    decimals: 1,
    get: (cam) => cam.pitchDeg,
    toPatch: (value, base) => ({ pitchDeg: value - base.pitchDeg }),
  },
  fov: {
    label: 'FOV',
    unit: '°',
    decimals: 0,
    get: (cam) => cam.fovDeg,
    toPatch: (value, base) => ({ fovDeg: value - base.fovDeg }),
  },
  range: {
    label: 'RANGE',
    unit: 'm',
    decimals: 0,
    get: (cam) => cam.rangeM,
    toPatch: (value, base) => ({
      rangeScale: base.rangeM > 0 ? value / base.rangeM : 1,
    }),
  },
  height: {
    label: 'HGT',
    unit: 'm',
    decimals: 0,
    get: (cam) => cam.mountHeightM,
    toPatch: (value, base) => ({ heightM: value - base.mountHeightM }),
  },
  north: {
    label: 'ΔN',
    unit: 'm',
    decimals: 1,
    get: (cam) => cam.calibration?.offsetNorthM || 0,
    toPatch: (value) => ({ offsetNorthM: value }),
  },
  east: {
    label: 'ΔE',
    unit: 'm',
    decimals: 1,
    get: (cam) => cam.calibration?.offsetEastM || 0,
    toPatch: (value) => ({ offsetEastM: value }),
  },
};

export function _activeCctvCameraId() {
  return this._cctvState?.activeCameraId || this._cctvSelect?.value || '';
}

export function _resetCctvCalibration() {
  const cameraId = this._activeCctvCameraId();
  if (!cameraId || !this.actions.setParams) return;
  this.actions.setParams(
    {
      selectedCameraId: cameraId,
      calibration: {
        cameraId,
        reset: true,
      },
    },
    { origin: 'user' },
  );
  this.actions.showToast('CCTV calibration reset');
}

export function _beginCctvCalValueEdit(chip) {
  if (this.destroyed) return;
  this._calibrationEdit?.(false);
  const field = CCTV_CAL_FIELDS[chip.dataset.calField];
  const activeCamera = this._cctvState?.activeCamera;
  if (!field || !activeCamera?.basePose) return;
  const cameraId = this._activeCctvCameraId();
  const basePose = { ...activeCamera.basePose };
  const editListeners = new AbortController();
  const startValue = field.get(activeCamera);
  const input = document.createElement('input');
  input.type = 'number';
  input.step = field.decimals > 0 ? '0.1' : '1';
  input.value = Number(startValue).toFixed(field.decimals);
  input.className = 'cctv-cal-input';
  chip.textContent = `${field.label} `;
  chip.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    editListeners.abort();
    this._calibrationEdit = null;
    const typed = parseFloat(input.value);
    input.remove();
    if (
      commit &&
      !this.destroyed &&
      Number.isFinite(typed) &&
      this._cctvState?.enabled &&
      this.actions.isEnabled() &&
      cameraId === this._activeCctvCameraId()
    ) {
      if (cameraId && this.actions.setParams) {
        this.actions.setParams(
          {
            selectedCameraId: cameraId,
            calibration: { cameraId, patch: field.toPatch(typed, basePose) },
          },
          { origin: 'user' },
        );
        return; // re-render restores the chip text from fresh state
      }
    }
    this._syncCctvCalReadout(
      !!this._cctvState?.enabled,
      this._cctvState?.activeCamera || null,
    );
  };
  this._calibrationEdit = finish;
  input.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      event.stopPropagation();
    },
    { signal: editListeners.signal },
  );
  input.addEventListener('blur', () => finish(true), {
    signal: editListeners.signal,
  });
  input.addEventListener('click', (event) => event.stopPropagation(), {
    signal: editListeners.signal,
  });
}

export function _syncCctvCalReadout(enabled, activeCamera) {
  const canCalibrate = !!enabled && !!activeCamera;
  if (this._cctvAdjustBtn) {
    const adjustOn = !!this._cctvState?.calibrationMode;
    this._cctvAdjustBtn.classList.toggle('active', adjustOn && canCalibrate);
    this._cctvAdjustBtn.textContent = adjustOn ? 'ADJUST ON' : 'ADJUST';
    this._cctvAdjustBtn.disabled = !canCalibrate;
  }
  if (this._cctvCalReadout) {
    for (const chip of this._cctvCalReadout.querySelectorAll(
      '.cctv-cal-value',
    )) {
      if (chip.querySelector('input')) continue; // an edit is in flight — don't clobber
      const field = CCTV_CAL_FIELDS[chip.dataset.calField];
      if (!field) continue;
      const value = canCalibrate ? field.get(activeCamera) : null;
      chip.textContent = Number.isFinite(value)
        ? `${field.label} ${Number(value).toFixed(field.decimals)}${field.unit}`
        : `${field.label} --`;
      chip.disabled = !canCalibrate;
    }
  }
  for (const el of [this._cctvCalibSaveBtn, this._cctvCalibResetBtn]) {
    if (el) el.disabled = !canCalibrate;
  }
}

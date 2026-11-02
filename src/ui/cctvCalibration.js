import { formatNumber, isolate, msg, t } from '../i18n/index.js';

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
    label: msg('HDG'),
    unit: '°',
    decimals: 1,
    get: (cam) => cam.headingDeg,
    toPatch: (value, base) => ({
      headingDeg: signedNormalizeDeg(value - base.headingDeg),
    }),
  },
  pitch: {
    label: msg('PITCH'),
    unit: '°',
    decimals: 1,
    get: (cam) => cam.pitchDeg,
    toPatch: (value, base) => ({ pitchDeg: value - base.pitchDeg }),
  },
  fov: {
    label: msg('FOV'),
    unit: '°',
    decimals: 0,
    get: (cam) => cam.fovDeg,
    toPatch: (value, base) => ({ fovDeg: value - base.fovDeg }),
  },
  range: {
    label: msg('RANGE'),
    unit: 'm',
    decimals: 0,
    get: (cam) => cam.rangeM,
    toPatch: (value, base) => ({
      rangeScale: base.rangeM > 0 ? value / base.rangeM : 1,
    }),
  },
  height: {
    label: msg('HGT'),
    unit: 'm',
    decimals: 0,
    get: (cam) => cam.mountHeightM,
    toPatch: (value, base) => ({ heightM: value - base.mountHeightM }),
  },
  north: {
    label: msg('ΔN'),
    unit: 'm',
    decimals: 1,
    get: (cam) => cam.calibration?.offsetNorthM || 0,
    toPatch: (value) => ({ offsetNorthM: value }),
  },
  east: {
    label: msg('ΔE'),
    unit: 'm',
    decimals: 1,
    get: (cam) => cam.calibration?.offsetEastM || 0,
    toPatch: (value) => ({ offsetEastM: value }),
  },
};

/** Chip text for one pose value: locale decimals, translated metre unit. */
function calValueText(field, value) {
  const options = {
    minimumFractionDigits: field.decimals,
    maximumFractionDigits: field.decimals,
  };
  if (field.unit === 'm') {
    // English keeps its compact "RANGE 120m"; other languages space the unit.
    const metres = formatNumber(Number(value), {
      useGrouping: false,
      ...options,
    });
    return `${t(field.label)} ${isolate(t('{value}m', { value: metres }))}`;
  }
  const number = formatNumber(Number(value), {
    useGrouping: false,
    ...options,
  });
  // Isolated so a minus sign stays on its number in right-to-left text.
  return `${t(field.label)} ${isolate(`${number}${field.unit}`)}`;
}

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
  this.actions.showToast(t('CCTV calibration reset'));
}

export function _beginCctvCalValueEdit(chip) {
  if (this.destroyed) return;
  this._calibrationEdit?.(false);
  const fieldId = chip.dataset.calField;
  const field = CCTV_CAL_FIELDS[fieldId];
  const activeCamera = this._cctvState?.activeCamera;
  if (!field || !activeCamera?.basePose) return;
  const cameraId = this._activeCctvCameraId();
  const basePose = { ...activeCamera.basePose };

  let finished = false;
  /**
   * End the edit: commit converts the typed value to a calibration offset
   * against the pose captured when it began; anything else just closes it.
   */
  const finish = (commit, typedText = '') => {
    if (finished) return;
    finished = true;
    this._calibrationEdit = null;
    this.store.setCalEdit(null);
    const typed = parseFloat(typedText);
    if (
      commit &&
      !this.destroyed &&
      Number.isFinite(typed) &&
      this._cctvState?.enabled &&
      this.actions.isEnabled() &&
      cameraId &&
      cameraId === this._activeCctvCameraId() &&
      this.actions.setParams
    ) {
      this.actions.setParams(
        {
          selectedCameraId: cameraId,
          calibration: { cameraId, patch: field.toPatch(typed, basePose) },
        },
        { origin: 'user' },
      );
    }
  };
  this._calibrationEdit = finish;
  // The readout renders a number input in this chip; Enter or blur commits
  // and Escape cancels through `finish`.
  this.store.setCalEdit({
    field: fieldId,
    label: `${t(field.label)} `,
    ariaLabel: t(field.label),
    step: field.decimals > 0 ? '0.1' : '1',
    value: Number(field.get(activeCamera)).toFixed(field.decimals),
    finish,
  });
}

/**
 * The calibration block for a camera state: ADJUST, the pose chips and
 * whether calibration is possible. Chips show the effective pose.
 * @param {object|null} state Camera layer UI state.
 * @param {boolean} enabled Whether the layer is on.
 */
export function presentCctvCalibration(state, enabled) {
  const activeCamera = state?.activeCamera || null;
  const canCalibrate = !!enabled && !!activeCamera;
  const adjustOn = !!state?.calibrationMode;
  const values = {};
  for (const [id, field] of Object.entries(CCTV_CAL_FIELDS)) {
    const value = canCalibrate ? field.get(activeCamera) : null;
    values[id] = Number.isFinite(value)
      ? calValueText(field, value)
      : `${t(field.label)} --`;
  }
  return {
    disabled: !canCalibrate,
    adjust: {
      active: adjustOn && canCalibrate,
      text: adjustOn ? t('ADJUST ON') : t('ADJUST'),
    },
    values,
  };
}

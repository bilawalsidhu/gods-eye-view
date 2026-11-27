import { t } from '../i18n/index.js';

/**
 * Turn CCTV on for a focus control, then focus — unless the panel went away,
 * a newer action started, the layer stayed off or another camera became active
 * meanwhile. Resolves true when it focused.
 */
async function focusAfterEnable(controls, activate, focus) {
  const generation = ++controls._actionGeneration;
  const activeId = controls._cctvState?.activeCameraId;
  if (!(await controls.actions.toggleEnabled(true))) return false;
  if (
    controls.destroyed ||
    generation !== controls._actionGeneration ||
    !controls.actions.isEnabled() ||
    (activeId && activeId !== controls._cctvState?.activeCameraId)
  )
    return false;
  controls.actions.runExplicitFocus(activate, focus);
  return true;
}

export function _initCctvPanel() {
  if (!this._cctvPanel) return;

  this.listen(this._cctvEnableBtn, 'click', async () => {
    this._actionGeneration++;
    await this.actions.toggleEnabled();
  });

  this.listen(this._cctvNearestBtn, 'click', () =>
    focusAfterEnable(
      this,
      () => this.cctv.focusNearest({ focus: false }),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.8),
    ),
  );

  this.listen(this._cctvPrevBtn, 'click', () =>
    focusAfterEnable(
      this,
      () => this.cctv.cycleCamera(-1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    ),
  );

  this.listen(this._cctvNextBtn, 'click', () =>
    focusAfterEnable(
      this,
      () => this.cctv.cycleCamera(1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    ),
  );

  // The picker defers rebuilds while focused; catch up once it lets go.
  this.listen(this._cctvSelect, 'blur', () => {
    this._picker = null;
    this._renderCctvState(this._cctvState);
  });

  this.listen(this._cctvSelect, 'change', async () => {
    const cameraId = this._cctvSelect.value;
    if (!cameraId) {
      this._actionGeneration++;
      return;
    }
    // Picking a camera from the dropdown flies to it. The dropdown lists the
    // cameras in view (and the active camera, which may be far away), so a
    // bare selection could leave the view somewhere else.
    if (
      await focusAfterEnable(
        this,
        () => (this.cctv.selectCamera(cameraId) ? cameraId : null),
        (selectedId) => this.cctv.focusCamera(selectedId, 2.2),
      )
    )
      this.actions.setParams(
        { selectedCameraId: cameraId },
        { origin: 'user' },
      );
  });

  this.listen(this._cctvFocusBtn, 'click', async () => {
    const selected = this._cctvState?.activeCameraId || this._cctvSelect?.value;
    if (!selected) {
      this._actionGeneration++;
      return;
    }
    if (
      await focusAfterEnable(
        this,
        () => selected,
        (cameraId) => this.cctv.focusCamera(cameraId, 1.9),
      )
    )
      this.actions.setParams(
        { selectedCameraId: selected },
        { origin: 'user' },
      );
  });

  this.listen(this._cctvCoverageBtn, 'click', () => {
    const current =
      this._cctvState?.coverageMode ||
      (this._cctvState?.showCoverage ? 'on' : 'off');
    const next =
      current === 'off' ? 'on' : current === 'on' ? 'viewshed' : 'off';
    this.actions.setParams({ coverageMode: next }, { origin: 'user' });
  });

  this.listen(this._cctvAutoHopBtn, 'click', () => {
    const current = !!this._cctvState?.autoHop;
    this.actions.setParams({ autoHop: !current }, { origin: 'user' });
  });

  this.listen(this._cctvProjectionBtn, 'click', () => {
    const current = this._cctvState?.showProjection !== false;
    this.actions.setParams({ showProjection: !current }, { origin: 'user' });
  });

  this.listen(this._cctvAdjustBtn, 'click', () => {
    const current = !!this._cctvState?.calibrationMode;
    this.actions.setParams({ calibrationMode: !current }, { origin: 'user' });
  });

  // Click-to-edit pose readout: each chip swaps to a number input; Enter or
  // blur commits (converted to a calibration offset against basePose),
  // Escape cancels. Delegated so re-renders never re-bind.
  this.listen(this._cctvCalReadout, 'click', (event) => {
    const chip = event.target.closest?.('.cctv-cal-value');
    if (!chip || chip.disabled || chip.querySelector('input')) return;
    this._beginCctvCalValueEdit(chip);
  });

  this.listen(this._cctvCalibSaveBtn, 'click', () => {
    const cameraId = this._activeCctvCameraId();
    if (!cameraId) return;
    this.actions.setParams(
      {
        selectedCameraId: cameraId,
        calibration: { cameraId, save: true },
      },
      { origin: 'user' },
    );
    this.actions.showToast(t('CCTV calibration saved'));
  });

  this.listen(this._cctvCalibResetBtn, 'click', () => {
    this._resetCctvCalibration();
  });

  this._renderCctvState(null);
  this.actions.syncViewport();
}

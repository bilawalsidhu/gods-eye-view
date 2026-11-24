import { t } from '../i18n/index.js';
import { translateStatusMessage } from './statusText.js';
import { shouldExpandGlobalContextPanel } from '../rightRailPolicy.js';

export function _initGlobalContextPanel() {
  this.listen(this._globalContextFlightsBtn, 'click', () => {
    if (
      this.destroyed ||
      this._contextModeChanging ||
      this._clearSelectedLayersPromise
    )
      return;
    const nextMode = this._contextMode === 'flights' ? null : 'flights';
    this._claimContextVisualAuthority();
    void this._runUserFacingContextAction(
      (notificationToken) =>
        this._selectContextMode(nextMode, { notificationToken }),
      t('Contacts could not complete the requested transition; try again'),
    ).then((succeeded) => {
      if (
        !this.destroyed &&
        nextMode &&
        shouldExpandGlobalContextPanel({
          action: 'contacts',
          explicitUserAction: true,
          succeeded: succeeded === true,
        })
      )
        this.actions.setPanelCollapsed('global-context-panel', false, {
          explicit: true,
        });
    });
  });
  this.listen(this._installationsSearchBtn, 'click', () => {
    if (
      this.destroyed ||
      !this._dataManager?.layers?.has('military-installations')
    )
      return;
    if (this._installationsSearchBusy) return;
    this._installationsSearchBusy = true;
    this._presentContext();
    void this._runUserFacingContextAction(async (notificationToken) => {
      const enabled = await this._dataManager.setEnabled(
        'military-installations',
        true,
        {
          origin: 'user',
          notificationToken,
        },
      );
      if (
        this.destroyed ||
        enabled === false ||
        !this._dataManager.isEnabled('military-installations')
      )
        return false;
      const searched = await this.installations.searchNearby?.();
      if (this.destroyed || searched === false) return false;
      const stats = this.installations.getStats?.();
      this.showToast(
        (stats?.statusMessage && translateStatusMessage(stats.statusMessage)) ||
          (stats?.status === 'zoom-in'
            ? t('Zoom in to search mapped installations')
            : t('Nearby installations refreshed')),
      );
      return true;
    }, t('Nearby installations could not be refreshed; try again')).finally(
      () => {
        if (this.destroyed) return;
        this._installationsSearchBusy = false;
        this._presentContext();
      },
    );
  });
}

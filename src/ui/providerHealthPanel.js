import { buildProviderHealthRows } from '../providerHealth.js';

/** Renders and refreshes the provider health popover owned by the application shell. */
export class ProviderHealthPanel {
  constructor({
    documentRef = globalThis.document,
    now = () => Date.now(),
    timers = globalThis,
  } = {}) {
    this._document = documentRef || null;
    this._toggle = this._document?.getElementById('provider-health-toggle');
    this._panel = this._document?.getElementById('provider-health-panel');
    this._list = this._document?.getElementById('provider-health-list');
    this._now = now;
    this._timers = timers;
    this._dataManager = null;
    this._unsubscribe = null;
    this._ticker = null;
    this._retryStarts = new Map();
    this._onToggle = null;

    if (!this._toggle || !this._panel || !this._list) return;
    this._onToggle = () => {
      const expanded = this._panel.hidden;
      this._panel.hidden = !expanded;
      this._toggle.setAttribute('aria-expanded', String(expanded));
      if (expanded) this._startTicker();
      else this._stopTicker();
      this.render();
    };
    this._toggle.addEventListener('click', this._onToggle);
    this.render();
  }

  connect(dataManager) {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._dataManager = dataManager || null;
    // Activity is the channel a layer's status and record counts travel on, so
    // the rows and the summary follow the feeds without a manual refresh. A
    // manager that only publishes lifecycle transitions still refreshes us.
    const subscribe =
      this._dataManager?.subscribeActivity || this._dataManager?.subscribe;
    if (typeof subscribe === 'function') {
      this._unsubscribe = subscribe.call(this._dataManager, () =>
        this.render(),
      );
    }
    this.render();
  }

  render() {
    if (!this._list || !this._document) return;
    const rows = buildProviderHealthRows(
      this._dataManager?.getAll?.() || [],
      this._now(),
    );
    const liveCount = rows.filter((row) => row.state === 'nominal').length;
    const attentionCount = rows.filter(
      (row) => !['off', 'nominal'].includes(row.state),
    ).length;
    this._toggle
      ?.querySelector('[data-health-summary]')
      ?.replaceChildren(
        this._document.createTextNode(
          `${liveCount} live · ${attentionCount} attention`,
        ),
      );
    if (this._panel?.hidden) return;

    this._list.replaceChildren();
    for (const row of rows) {
      const item = this._document.createElement('div');
      item.className = `provider-health-row health-${row.state}`;
      const heading = this._document.createElement('div');
      heading.className = 'provider-health-heading';
      const name = this._document.createElement('strong');
      name.textContent = row.name;
      const state = this._document.createElement('span');
      state.className = 'provider-health-state';
      state.textContent = row.label;
      heading.append(name, state);

      const detail = this._document.createElement('div');
      detail.className = 'provider-health-detail';
      const count =
        row.count === null ? '—' : new Intl.NumberFormat().format(row.count);
      const detailParts = [row.source, row.detail];
      if (row.updated && row.updated !== row.detail)
        detailParts.push(`updated ${row.updated}`);
      detailParts.push(`${count} records`);
      if (row.retryInSec > 0) {
        const retry = this._retryStarts.get(row.id);
        const startedAt =
          retry?.value === row.retryInSec ? retry.startedAt : this._now();
        if (!retry || retry.value !== row.retryInSec) {
          this._retryStarts.set(row.id, { value: row.retryInSec, startedAt });
        }
        const remaining = Math.max(
          0,
          row.retryInSec - Math.floor((this._now() - startedAt) / 1000),
        );
        detailParts.push(`retry ${remaining}s`);
      } else {
        this._retryStarts.delete(row.id);
      }
      detail.textContent = detailParts.join(' · ');
      item.append(heading, detail);
      this._list.appendChild(item);
    }
  }

  destroy() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._toggle?.removeEventListener('click', this._onToggle);
    this._onToggle = null;
    this._stopTicker();
  }

  _startTicker() {
    if (this._ticker) return;
    this._ticker = this._timers.setInterval(() => this.render(), 1000);
  }

  _stopTicker() {
    if (this._ticker) this._timers.clearInterval(this._ticker);
    this._ticker = null;
    this._retryStarts.clear();
  }
}

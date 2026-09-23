const element = (documentRef, tag, className, text) => {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
};

/** Dedicated, provenance-first view for Cyber records without map geometry. */
export class CyberIntelPanel {
  constructor({ documentRef = globalThis.document } = {}) {
    this.document = documentRef;
    this.panel = documentRef?.getElementById?.('cyber-intel-panel') || null;
    this.body = documentRef?.getElementById?.('cyber-intel-body') || null;
    this._wasEnabled = false;
  }

  mount(layer) {
    this.layer = layer;
    if (
      !this.panel ||
      !this.body ||
      typeof layer?.setThreatIntelListener !== 'function'
    )
      return;
    layer.setThreatIntelListener((state) => this.render(state));
    this.render(layer.getThreatIntelState());
  }

  _renderSelection(selection) {
    const section = element(this.document, 'section', 'cyber-intel-selection');
    section.setAttribute('aria-label', 'Selected Cloudflare Radar observation');
    section.append(
      element(
        this.document,
        'h3',
        '',
        selection.type === 'flow'
          ? 'SELECTED RADAR FLOW'
          : 'SELECTED RADAR LOCATION',
      ),
    );
    const rows =
      selection.type === 'flow'
        ? [
            ['Origin', `${selection.origin.name} (${selection.origin.code})`],
            ['Target', `${selection.target.name} (${selection.target.code})`],
            [
              'Share',
              `${Number.isFinite(selection.share) ? selection.share : 'Unavailable'}% of reported mitigated requests`,
            ],
            ['Rank', selection.rank],
            [
              'Window',
              `${selection.windowStart || '—'} to ${selection.windowEnd || '—'} UTC`,
            ],
            [
              'Location',
              'Country reference coordinates; not a device or network path',
            ],
          ]
        : selection.roles?.length > 1
          ? [
              ['Roles', selection.roles.map((row) => row.role).join(' and ')],
              [
                'Country',
                `${selection.locationName || 'Unknown'}${selection.locationCode ? ` (${selection.locationCode})` : ''}`,
              ],
              ...selection.roles.map((row) => [
                `${row.role === 'origin' ? 'Origin' : 'Target'} share / rank`,
                `${Number.isFinite(row.share) ? row.share : 'Unavailable'}% / ${row.rank ?? '—'}`,
              ]),
              [
                'Window',
                `${selection.windowStart || '—'} to ${selection.windowEnd || '—'} UTC`,
              ],
              [
                'Location',
                'Country reference coordinates; not a device location',
              ],
            ]
          : [
              [
                'Role',
                selection.category?.endsWith('-origin')
                  ? 'Origin country aggregate'
                  : 'Target country aggregate',
              ],
              [
                'Country',
                `${selection.locationName || 'Unknown'}${selection.locationCode ? ` (${selection.locationCode})` : ''}`,
              ],
              [
                'Share',
                `${Number.isFinite(selection.share) ? selection.share : 'Unavailable'}% of reported mitigated requests`,
              ],
              ['Rank', selection.rank],
              [
                'Window',
                `${selection.windowStart || '—'} to ${selection.windowEnd || '—'} UTC`,
              ],
              [
                'Location',
                'Country reference coordinates; not a device location',
              ],
            ];
    for (const [label, value] of rows) {
      const row = element(this.document, 'p', 'cyber-intel-detail-row');
      row.append(element(this.document, 'strong', '', `${label}: `));
      row.append(this.document.createTextNode(String(value ?? '—')));
      section.append(row);
    }
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-provenance',
        [selection.detail, selection.geographicProvenance]
          .filter(Boolean)
          .join(' '),
      ),
    );
    return section;
  }

  _renderProvider(provider) {
    const section = element(this.document, 'section', 'cyber-intel-provider');
    const heading = element(
      this.document,
      'div',
      'cyber-intel-provider-heading',
    );
    heading.append(element(this.document, 'h3', '', provider.label));
    heading.append(
      element(
        this.document,
        'span',
        provider.stale ? 'is-stale' : 'is-current',
        provider.stale ? 'STALE CACHE' : provider.status,
      ),
    );
    section.append(heading);
    if (provider.error)
      section.append(
        element(this.document, 'p', 'cyber-intel-empty', provider.error),
      );
    else if (!provider.observations?.length && !provider.ports?.length)
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-empty',
          'Waiting for the first feed update.',
        ),
      );

    if (provider.observations?.length) {
      section.append(
        element(this.document, 'h4', '', 'Current Top 10 malicious sources'),
      );
      const table = element(this.document, 'table', 'cyber-intel-source-table');
      const head = element(this.document, 'thead');
      const headerRow = element(this.document, 'tr');
      for (const label of ['IP Address', 'Domain Name'])
        headerRow.append(element(this.document, 'th', '', label));
      head.append(headerRow);
      table.append(head);
      const body = element(this.document, 'tbody');
      for (const record of provider.observations.slice(0, 10)) {
        const row = element(this.document, 'tr');
        row.append(
          element(
            this.document,
            'td',
            '',
            record.indicator?.value || 'Unknown IP',
          ),
        );
        row.append(
          element(this.document, 'td', '', record.hostname || 'Unavailable'),
        );
        body.append(row);
      }
      table.append(body);
      section.append(table);
    }
    if (provider.ports?.length) {
      section.append(
        element(this.document, 'h4', '', 'Current Top 10 Targeted Ports'),
      );
      const list = element(
        this.document,
        'ul',
        'cyber-intel-record-list cyber-intel-port-list',
      );
      for (const port of provider.ports.slice(0, 10)) {
        const item = element(this.document, 'li', '');
        item.append(
          element(this.document, 'strong', '', `${port.port}/${port.protocol}`),
        );
        item.append(
          element(
            this.document,
            'span',
            '',
            port.label || 'Unlabelled service',
          ),
        );
        list.append(item);
      }
      section.append(list);
    }
    section.append(
      element(this.document, 'p', 'cyber-intel-provenance', provider.notice),
    );
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-attribution',
        `${provider.attribution}${provider.fetchedAt ? ` · fetched ${provider.fetchedAt}` : ''}`,
      ),
    );
    return section;
  }

  _renderLegend() {
    const legend = element(this.document, 'section', 'cyber-intel-legend');
    legend.setAttribute('aria-label', 'Cyber map legend');
    const entries = [
      ['cyber-legend-origin', 'Origin aggregate · client IP country'],
      [
        'cyber-legend-target',
        'Target aggregate · zone billing country when available',
      ],
      ['cyber-legend-both', 'Origin and target country'],
      ['cyber-legend-flow', 'Red arrow · reported origin → target pair'],
    ];
    for (const [swatchClass, label] of entries) {
      const row = element(this.document, 'p', 'cyber-intel-legend-row');
      row.append(element(this.document, 'span', swatchClass));
      row.append(this.document.createTextNode(label));
      legend.append(row);
    }
    legend.append(
      element(
        this.document,
        'p',
        'cyber-intel-provenance',
        'Map positions are country reference anchors. Arrows show only the top 10 pairs Cloudflare reports; a dot without a line has no pair in that set. Arrows show aggregate associations, not device locations or network routes.',
      ),
    );
    return legend;
  }

  render(state) {
    if (!this.panel || !this.body) return;
    const isEnabled = state?.enabled === true;
    const becameEnabled = isEnabled && !this._wasEnabled;
    this._wasEnabled = isEnabled;
    this.panel.hidden = !isEnabled;
    this.panel.setAttribute('aria-hidden', String(!isEnabled));
    this.panel.inert = !isEnabled;
    this.body.replaceChildren();
    if (!isEnabled) return;

    this.body.append(this._renderLegend());

    if (state.selectedRadar) {
      this.body.append(this._renderSelection(state.selectedRadar));
      const disclosure = this.panel.querySelector(
        '[data-collapse-target="cyber-intel-panel"]',
      );
      if (this.panel.classList.contains('collapsed')) disclosure?.click();
    } else {
      this.body.append(
        element(
          this.document,
          'p',
          'cyber-intel-map-hint',
          'Select a Radar marker or flow arrow on the globe to inspect its country-level aggregate.',
        ),
      );
    }
    for (const provider of state.nonGeographicProviders || [])
      this.body.append(this._renderProvider(provider));
    if (becameEnabled && this.panel.classList.contains('collapsed'))
      this.panel
        .querySelector('[data-collapse-target="cyber-intel-panel"]')
        ?.click();
  }

  destroy() {
    this.layer?.setThreatIntelListener?.(null);
    this.layer = null;
    this.body?.replaceChildren();
    if (this.panel) {
      this.panel.hidden = true;
      this.panel.inert = true;
    }
    this._wasEnabled = false;
  }
}

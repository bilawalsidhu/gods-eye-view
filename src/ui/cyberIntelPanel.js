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
    this.devicePopup =
      typeof documentRef?.createElement === 'function'
        ? element(documentRef, 'div', 'cyber-device-popup')
        : null;
    if (this.devicePopup) {
      this.devicePopup.hidden = true;
      this.devicePopup.setAttribute('role', 'dialog');
      this.devicePopup.setAttribute('aria-label', 'Shodan device details');
    }
    if (this.devicePopup) documentRef?.body?.append?.(this.devicePopup);
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
    this._onBodyClick = (event) => {
      const button = event.target?.closest?.('[data-cyber-enrich]');
      if (button) {
        void layer
          .getThreatIntelState()
          .onEnrichIp?.(button.dataset.provider, button.dataset.ip);
        return;
      }
      const more = event.target?.closest?.('[data-shodan-page]');
      if (more) {
        const page = Number(more.dataset.shodanPage);
        if (
          page > 1 &&
          !globalThis.confirm?.(
            'Shodan result pages after the first may use query credits. Continue?',
          )
        )
          return;
        const query = more.dataset.query;
        void layer.getThreatIntelState().onShodanSearch?.(query, page);
        return;
      }
    };
    this._onBodySubmit = (event) => {
      const form = event.target?.closest?.('[data-shodan-search]');
      if (!form) return;
      event.preventDefault();
      const query = form.querySelector('input[name="query"]')?.value?.trim();
      void layer.getThreatIntelState().onShodanAreaSearch?.(query || '');
    };
    this._onDevicePopupClick = (event) => {
      if (!event.target?.closest?.('[data-close-shodan-popup]')) return;
      layer.getThreatIntelState().onClearShodanSelection?.();
    };
    this.devicePopup?.addEventListener('click', this._onDevicePopupClick);
    this.body.addEventListener('click', this._onBodyClick);
    this.body.addEventListener('submit', this._onBodySubmit);
    this.render(layer.getThreatIntelState());
  }

  _renderEnrichment(result, provider, pending = false) {
    const section = element(
      this.document,
      'section',
      'cyber-intel-enrichment-result',
    );
    section.append(
      element(
        this.document,
        'h4',
        '',
        provider === 'shodan'
          ? 'Shodan host intelligence'
          : 'GreyNoise IP context',
      ),
    );
    if (pending) {
      section.append(
        element(this.document, 'p', 'cyber-intel-empty', 'Looking up this IP…'),
      );
      return section;
    }
    if (!result || result.error) {
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-empty',
          result?.error || 'No result yet.',
        ),
      );
      return section;
    }
    const rows =
      provider === 'shodan'
        ? [
            ['IP', result.ip],
            ['Organization', result.organization],
            ['ISP', result.isp],
            [
              'Location',
              [result.city, result.region, result.country]
                .filter(Boolean)
                .join(', ') || 'Unavailable',
            ],
            [
              'Services',
              (result.services || [])
                .map(
                  (service) =>
                    `${service.port ?? '?'}${service.transport ? `/${service.transport}` : ''}${service.product ? ` · ${service.product}` : ''}${service.version ? ` ${service.version}` : ''}`,
                )
                .join('; ') || 'None reported',
            ],
            [
              'Domains',
              [...(result.hostnames || []), ...(result.domains || [])].join(
                ', ',
              ) || 'None reported',
            ],
            [
              'Geography',
              result.geographicPrecision
                ? 'Approximate IP network location; not a device or person location.'
                : 'Unavailable',
            ],
          ]
        : [
            ['IP', result.ip],
            ['Classification', result.classification || 'Unknown'],
            [
              'Noise',
              result.noise == null ? 'Unknown' : result.noise ? 'Yes' : 'No',
            ],
            [
              'RIOT',
              result.riot == null ? 'Unknown' : result.riot ? 'Yes' : 'No',
            ],
            ['Organization', result.organization],
            ['Last seen', result.lastSeen],
            ['Details', result.message],
          ];
    for (const [label, value] of rows) {
      const row = element(this.document, 'p', 'cyber-intel-detail-row');
      row.append(element(this.document, 'strong', '', `${label}: `));
      row.append(this.document.createTextNode(String(value || 'Unavailable')));
      section.append(row);
    }
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-attribution',
        `${result.attribution || provider} · fetched ${result.fetchedAt || 'unknown'}`,
      ),
    );
    return section;
  }

  _renderShodanSearch(state) {
    const section = element(this.document, 'section', 'cyber-intel-provider');
    const areaSearch = state.shodanAreaSearch;
    section.append(element(this.document, 'h3', '', 'Optional Shodan search'));
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-provenance cyber-shodan-credit-note',
        'A search uses one query credit.',
      ),
    );
    const form = element(this.document, 'form', 'cyber-intel-search-form');
    form.dataset.shodanSearch = 'true';
    const input = element(this.document, 'input');
    input.name = 'query';
    input.type = 'search';
    input.maxLength = 120;
    input.placeholder = 'Port/Service/CVE';
    input.setAttribute('aria-label', 'Shodan search query');
    input.value = areaSearch?.userQuery || '';
    const submit = element(
      this.document,
      'button',
      'cyber-shodan-area-button',
      state.shodanAreaSearch?.loading
        ? 'Searching this area…'
        : 'Shodan Search',
    );
    submit.type = 'submit';
    submit.disabled = state.shodanAreaSearch?.loading === true;
    form.append(input, submit);
    section.append(form);
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-provenance',
        'Searches a circle centered on the current map view (up to 1,000 km radius), applies the optional query, and checks the first 100 Shodan results. Up to 100 unique devices are shown and mapped when coordinates are available. If Shodan has no coordinates, cached server-side IPwho.is approximate network geolocation is used when available. Unresolved devices are not mapped. Public IPs requiring fallback geolocation are sent to IPwho.is.',
      ),
    );
    if (areaSearch?.error)
      section.append(
        element(this.document, 'p', 'cyber-intel-empty', areaSearch.error),
      );
    const areaMatches = areaSearch?.matches || [];
    if (areaMatches.length) {
      const mappedCount = areaMatches.filter(
        (result) =>
          Number.isFinite(result.latitude) && Number.isFinite(result.longitude),
      ).length;
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-provenance',
          `${mappedCount} of ${areaMatches.length} returned devices have map positions. Devices sharing one approximate IP location are individually fanned around it, with connector lines. Those display offsets are not measured device locations. Unresolved IPs remain listed without a fabricated location.`,
        ),
      );
    }
    for (const result of areaMatches) {
      const row = element(this.document, 'div', 'cyber-intel-search-result');
      row.append(element(this.document, 'strong', '', result.ip));
      row.append(
        element(
          this.document,
          'span',
          '',
          [result.city, result.region, result.country, result.organization]
            .filter(Boolean)
            .join(' · ') || 'Location unavailable',
        ),
      );
      for (const provider of ['shodan', 'greynoise']) {
        const button = element(
          this.document,
          'button',
          '',
          provider === 'shodan' ? 'Host details' : 'GreyNoise',
        );
        button.type = 'button';
        button.dataset.cyberEnrich = 'true';
        button.dataset.provider = provider;
        button.dataset.ip = result.ip;
        row.append(button);
      }
      section.append(row);
    }
    return section;
  }

  _renderSelection(selection) {
    const section = element(this.document, 'section', 'cyber-intel-selection');
    section.setAttribute(
      'aria-label',
      selection.type === 'shodan-asset'
        ? 'Selected Shodan device'
        : 'Selected Cloudflare Radar observation',
    );
    section.append(
      element(
        this.document,
        'h3',
        '',
        selection.type === 'shodan-asset'
          ? 'SELECTED SHODAN DEVICE'
          : selection.type === 'flow'
            ? 'SELECTED RADAR FLOW'
            : 'SELECTED RADAR LOCATION',
      ),
    );
    if (selection.type === 'shodan-asset') {
      const close = element(
        this.document,
        'button',
        'cyber-device-popup-close',
        '×',
      );
      close.type = 'button';
      close.setAttribute('aria-label', 'Close Shodan device details');
      close.dataset.closeShodanPopup = 'true';
      section.append(close);
    }
    const rows =
      selection.type === 'shodan-asset'
        ? [
            ['IP', selection.ip],
            ['Organization', selection.organization],
            [
              'Services',
              (selection.services || [])
                .map(
                  (service) =>
                    `${service.port ?? '?'}${service.transport ? `/${service.transport}` : ''}${service.product ? ` · ${service.product}` : ''}`,
                )
                .join('; ') || 'None reported',
            ],
            [
              'Hostnames',
              [
                ...(selection.hostnames || []),
                ...(selection.domains || []),
              ].join(', ') || 'None reported',
            ],
            [
              'Location',
              [selection.city, selection.region, selection.country]
                .filter(Boolean)
                .join(', ') || 'Unavailable',
            ],
            ['Geography', selection.geographicProvenance || 'Unavailable'],
            ['Location method', selection.geographicMethod || 'Unavailable'],
            [
              'Source',
              `${selection.attribution} · fetched ${selection.fetchedAt}`,
            ],
          ]
        : selection.type === 'flow'
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
    if (selection.type === 'shodan-asset') {
      if (selection.visualOffsetMeters > 0) {
        section.append(
          element(
            this.document,
            'p',
            'cyber-intel-provenance',
            `This dot is offset about ${Math.round(selection.visualOffsetMeters)} m from a shared IP-location point for visibility only; the offset is not a measured device location.`,
          ),
        );
      }
      const link = element(
        this.document,
        'a',
        'cyber-shodan-host-link',
        'Open this host on Shodan ↗',
      );
      link.href = `https://www.shodan.io/host/${encodeURIComponent(selection.ip)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      section.append(link);
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
    if (provider.id === 'dshield')
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-provenance',
          'GreyNoise lookups use your Community API allowance. Eligible free accounts currently allow up to 50 weekly searches combined with Visualizer use; limits and eligibility can change.',
        ),
      );
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
        const actions = element(this.document, 'div', 'cyber-intel-actions');
        for (const source of ['shodan', 'greynoise']) {
          const ip = record.indicator?.value;
          if (!ip || record.indicator?.type !== 'ipv4') continue;
          const button = element(
            this.document,
            'button',
            '',
            source === 'shodan' ? 'Shodan lookup' : 'GreyNoise lookup',
          );
          button.type = 'button';
          button.dataset.cyberEnrich = 'true';
          button.dataset.provider = source;
          button.dataset.ip = ip;
          actions.append(button);
        }
        body.append(row);
        if (actions.children.length) {
          const actionRow = element(this.document, 'tr');
          const actionCell = element(this.document, 'td');
          actionCell.setAttribute('colspan', '2');
          actionCell.append(actions);
          actionRow.append(actionCell);
          body.append(actionRow);
        }
        for (const source of ['shodan', 'greynoise']) {
          const key = `${source}:${record.indicator?.value}`;
          const value = provider.enrichmentResults?.[key];
          const pending = provider.enrichmentPending?.includes(key);
          if (value || pending) {
            const result = this._renderEnrichment(value, source, pending);
            const resultRow = element(this.document, 'tr');
            const cell = element(this.document, 'td');
            cell.setAttribute('colspan', '2');
            cell.append(result);
            resultRow.append(cell);
            body.append(resultRow);
          }
        }
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
    if (provider.id === 'dshield')
      section.append(this._renderShodanSearch(provider));
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
      ['cyber-legend-shodan', 'Gold dot · searched Shodan device'],
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
        'Radar positions are country reference anchors. Arrows show only the top 10 pairs Cloudflare reports; a dot without a line has no pair in that set. Arrows show aggregate associations, not network routes. Shodan devices appear only after an area search; their IP-based positions are approximate network locations.',
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
    if (!isEnabled) {
      if (this.devicePopup) this.devicePopup.hidden = true;
      return;
    }

    if (state.selectedShodan && this.devicePopup) {
      this.devicePopup.hidden = false;
      this.devicePopup.replaceChildren(
        this._renderSelection({
          ...state.selectedShodan,
          type: 'shodan-asset',
        }),
      );
      const point = state.selectedShodan.popupPosition;
      const viewportWidth = globalThis.innerWidth || 1280;
      const viewportHeight = globalThis.innerHeight || 800;
      const left = Math.min(
        Math.max(12, (point?.x ?? viewportWidth / 2) + 14),
        Math.max(12, viewportWidth - 352),
      );
      const top = Math.min(
        Math.max(12, (point?.y ?? viewportHeight / 2) + 14),
        Math.max(12, viewportHeight - 300),
      );
      this.devicePopup.style.left = `${left}px`;
      this.devicePopup.style.top = `${top}px`;
    } else if (this.devicePopup) this.devicePopup.hidden = true;

    this.body.append(this._renderLegend());

    const selected = state.selectedRadar;
    if (selected) {
      this.body.append(this._renderSelection(selected));
      const disclosure = this.panel.querySelector(
        '[data-collapse-target="cyber-intel-panel"]',
      );
      if (this.panel.classList.contains('collapsed')) disclosure?.click();
    } else if (!state.selectedShodan || !this.devicePopup) {
      this.body.append(
        element(
          this.document,
          'p',
          'cyber-intel-map-hint',
          'Select a Radar marker, flow arrow, or Shodan device on the globe to inspect its details.',
        ),
      );
    }
    for (const provider of state.nonGeographicProviders || [])
      this.body.append(this._renderProvider(provider));
    if (state.enrichmentMessage)
      this.body.append(
        element(
          this.document,
          'p',
          'cyber-intel-empty',
          state.enrichmentMessage,
        ),
      );
    if (becameEnabled && this.panel.classList.contains('collapsed'))
      this.panel
        .querySelector('[data-collapse-target="cyber-intel-panel"]')
        ?.click();
  }

  destroy() {
    if (this._onBodyClick)
      this.body?.removeEventListener('click', this._onBodyClick);
    if (this._onBodySubmit)
      this.body?.removeEventListener('submit', this._onBodySubmit);
    if (this._onDevicePopupClick)
      this.devicePopup?.removeEventListener('click', this._onDevicePopupClick);
    this._onBodyClick = null;
    this._onBodySubmit = null;
    this._onDevicePopupClick = null;
    this.layer?.setThreatIntelListener?.(null);
    this.layer = null;
    this.body?.replaceChildren();
    if (this.panel) {
      this.panel.hidden = true;
      this.panel.inert = true;
    }
    this.devicePopup?.remove?.();
    this.devicePopup && (this.devicePopup.hidden = true);
    this._wasEnabled = false;
  }
}

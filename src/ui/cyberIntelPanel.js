const element = (documentRef, tag, className, text) => {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
};

function kevMatchesForRecord(record, snapshot) {
  const byCve = new Map(
    (snapshot?.vulnerabilities || []).map((item) => [item.cveId, item]),
  );
  const ids = new Set(
    (record?.services || [])
      .flatMap((service) => service.vulnerabilities || [])
      .filter((cve) => /^CVE-\d{4}-\d{4,}$/i.test(cve)),
  );
  return [...ids].map((cve) => byCve.get(cve.toUpperCase())).filter(Boolean);
}

/** Dedicated, provenance-first view for Cyber records without map geometry. */
export class CyberIntelPanel {
  constructor({ documentRef = globalThis.document } = {}) {
    this.document = documentRef;
    this.panel = documentRef?.getElementById?.('cyber-intel-panel') || null;
    this.body = documentRef?.getElementById?.('cyber-intel-body') || null;
    this.legendPanel =
      documentRef?.getElementById?.('cyber-intel-legend-panel') || null;
    this.legendContent =
      documentRef?.getElementById?.('cyber-intel-map-legend-content') || null;
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
    this._kevFilter = '';
    this._kevVisibleCount = 25;
    this._kevResultsOpen = false;
    this._shodanResultsOpen = true;
    this._lastState = null;
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
      if (event.target?.closest?.('[data-kev-more]')) {
        this._kevVisibleCount += 25;
        this.render(this._lastState);
        return;
      }
      const button = event.target?.closest?.('[data-cyber-enrich]');
      if (button) {
        void layer
          .getThreatIntelState()
          .onEnrichIp?.(button.dataset.provider, button.dataset.ip);
        return;
      }
      const otxButton = event.target?.closest?.('[data-otx-lookup]');
      if (otxButton) {
        void layer
          .getThreatIntelState()
          .onOtxLookup?.(otxButton.dataset.indicator, 'auto');
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
    this._onPanelClick = (event) => {
      const button = event.target?.closest?.('[data-cyber-intel-expand]');
      if (!button) return;
      const expanded = !this.panel.classList.contains('cyber-intel-expanded');
      this.panel.classList.toggle('cyber-intel-expanded', expanded);
      button.setAttribute('aria-pressed', String(expanded));
      button.setAttribute(
        'aria-label',
        `${expanded ? 'Restore' : 'Expand'} Cyber Threat Intel panel size`,
      );
      button.title = `${expanded ? 'Restore' : 'Expand'} Cyber Threat Intel panel size`;
    };
    this._onLegendClick = (event) => {
      const button = event.target?.closest?.('[data-cyber-legend-collapse]');
      if (!button) return;
      const collapsed = !this.legendPanel.classList.contains(
        'cyber-legend-collapsed',
      );
      this.legendPanel.classList.toggle('cyber-legend-collapsed', collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute(
        'aria-label',
        `${collapsed ? 'Expand' : 'Collapse'} Cyber Intel Map Legend`,
      );
      button.title = `${collapsed ? 'Expand' : 'Collapse'} Cyber Intel Map Legend`;
      button.textContent = collapsed ? '⌃' : '⌄';
    };
    this._onBodySubmit = (event) => {
      const kevForm = event.target?.closest?.('[data-kev-search]');
      if (kevForm) {
        event.preventDefault();
        this._kevFilter =
          kevForm.querySelector('input[name="kev-query"]')?.value?.trim() || '';
        this._kevVisibleCount = 25;
        this.render(this._lastState);
        return;
      }
      const form = event.target?.closest?.('[data-shodan-search]');
      if (form) {
        event.preventDefault();
        const query = form.querySelector('input[name="query"]')?.value?.trim();
        void layer.getThreatIntelState().onShodanAreaSearch?.(query || '');
        return;
      }
      const otxForm = event.target?.closest?.('[data-otx-search]');
      if (!otxForm) return;
      event.preventDefault();
      const indicator = otxForm
        .querySelector('input[name="otx-indicator"]')
        ?.value?.trim();
      if (indicator)
        void layer.getThreatIntelState().onOtxLookup?.(indicator, 'auto');
    };
    this._onDevicePopupClick = (event) => {
      if (!event.target?.closest?.('[data-close-shodan-popup]')) return;
      layer.getThreatIntelState().onClearShodanSelection?.();
    };
    this.devicePopup?.addEventListener('click', this._onDevicePopupClick);
    this.body.addEventListener('click', this._onBodyClick);
    this.body.addEventListener('submit', this._onBodySubmit);
    this.panel.addEventListener('click', this._onPanelClick);
    this.legendPanel?.addEventListener('click', this._onLegendClick);
    this.render(layer.getThreatIntelState());
  }

  _renderEnrichment(result, provider, pending = false, kevSnapshot = null) {
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
    if (provider === 'shodan' && !pending && result?.services?.length) {
      const matches = kevMatchesForRecord(result, kevSnapshot);
      section.append(
        element(
          this.document,
          'h4',
          '',
          `CISA KEV matches · ${matches.length}`,
        ),
      );
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-provenance',
          matches.length
            ? matches.map((item) => item.cveId).join(', ')
            : kevSnapshot
              ? 'No explicit Shodan-reported CVE matched the CISA KEV catalog. Product similarity alone is not treated as a match.'
              : 'CISA KEV is unavailable, so matches could not be checked.',
        ),
      );
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
    section.append(
      element(this.document, 'h3', '', 'Shodan Exposed Device Search'),
    );
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
        'Searches the current map area (up to 1,000 km) and returns up to 100 devices. Missing coordinates may use approximate IP geolocation.',
      ),
    );
    if (areaSearch?.error)
      section.append(
        element(this.document, 'p', 'cyber-intel-empty', areaSearch.error),
      );
    const areaMatches = areaSearch?.matches || [];
    if (areaMatches.length) {
      const results = element(this.document, 'details', 'cyber-search-results');
      results.dataset.shodanResults = 'true';
      results.open = this._shodanResultsOpen;
      results.addEventListener('toggle', () => {
        this._shodanResultsOpen = results.open;
      });
      results.append(
        element(
          this.document,
          'summary',
          '',
          `Shodan results · ${areaMatches.length} devices`,
        ),
      );
      const mappedCount = areaMatches.filter(
        (result) =>
          Number.isFinite(result.latitude) && Number.isFinite(result.longitude),
      ).length;
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-provenance',
          `${mappedCount}/${areaMatches.length} mapped. Shared approximate locations use display offsets; unresolved IPs stay off-map.`,
        ),
      );
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
        const kevMatches = kevMatchesForRecord(result, state.kevSnapshot);
        if (kevMatches.length)
          row.append(
            element(
              this.document,
              'span',
              'cyber-kev-match-count',
              `CISA KEV · ${kevMatches.length} explicit CVE match${kevMatches.length === 1 ? '' : 'es'}`,
            ),
          );
        results.append(row);
        const key = `shodan:${result.ip}`;
        const enrichment = state.enrichmentResults?.[key];
        const pending = state.enrichmentPending?.includes(key);
        if (enrichment || pending)
          results.append(
            this._renderEnrichment(
              enrichment,
              'shodan',
              pending,
              state.kevSnapshot,
            ),
          );
      }
      section.append(results);
    }
    return section;
  }

  _renderKevCatalog(state) {
    const section = element(this.document, 'section', 'cyber-intel-provider');
    const heading = element(
      this.document,
      'div',
      'cyber-intel-provider-heading',
    );
    heading.append(
      element(this.document, 'h3', '', 'CISA Known Exploited Vulnerabilities'),
    );
    const snapshot = state.kevSnapshot;
    heading.append(
      element(
        this.document,
        'span',
        snapshot?.stale ? 'is-stale' : 'is-current',
        snapshot
          ? snapshot.stale
            ? 'STALE CACHE'
            : `UPDATED ${snapshot.fetchedAt}`
          : state.kevLoading
            ? 'LOADING'
            : 'UNAVAILABLE',
      ),
    );
    section.append(heading);
    if (!snapshot) {
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-empty',
          state.kevError || 'Loading the CISA KEV catalog…',
        ),
      );
      return section;
    }
    const form = element(this.document, 'form', 'cyber-intel-search-form');
    form.dataset.kevSearch = 'true';
    const input = element(this.document, 'input');
    input.type = 'search';
    input.name = 'kev-query';
    input.maxLength = 120;
    input.placeholder = 'CVE, vendor, or product';
    input.setAttribute('aria-label', 'Search the CISA KEV catalog');
    input.value = this._kevFilter;
    const submit = element(this.document, 'button', '', 'Search KEV');
    submit.type = 'submit';
    form.append(input, submit);
    section.append(form);
    const query = this._kevFilter.toLocaleLowerCase();
    const matches = snapshot.vulnerabilities.filter((item) =>
      [
        item.cveId,
        item.vendor,
        item.product,
        item.name,
        item.shortDescription,
      ].some((field) =>
        String(field || '')
          .toLocaleLowerCase()
          .includes(query),
      ),
    );
    const results = element(this.document, 'details', 'cyber-search-results');
    results.dataset.kevResults = 'true';
    results.open = this._kevResultsOpen;
    results.addEventListener('toggle', () => {
      this._kevResultsOpen = results.open;
    });
    results.append(
      element(
        this.document,
        'summary',
        '',
        `KEV results · ${matches.length} vulnerabilities`,
      ),
    );
    results.append(
      element(
        this.document,
        'p',
        'cyber-intel-provenance',
        `Catalog ${snapshot.catalogVersion} · released ${snapshot.dateReleased.slice(0, 10)}`,
      ),
    );
    for (const item of matches.slice(0, this._kevVisibleCount)) {
      const card = element(this.document, 'article', 'cyber-kev-entry');
      const title = element(this.document, 'div', 'cyber-kev-entry-heading');
      title.append(element(this.document, 'strong', '', item.cveId));
      title.append(
        element(this.document, 'span', '', `${item.vendor} · ${item.product}`),
      );
      card.append(title);
      const otxButton = element(this.document, 'button', '', 'OTX context');
      otxButton.type = 'button';
      otxButton.dataset.otxLookup = 'true';
      otxButton.dataset.indicator = item.cveId;
      card.append(otxButton);
      card.append(element(this.document, 'h4', '', item.name));
      card.append(
        element(
          this.document,
          'p',
          'cyber-kev-description',
          item.shortDescription,
        ),
      );
      const dates = element(this.document, 'p', 'cyber-kev-meta');
      dates.textContent = `Added ${item.dateAdded} · CISA due date ${item.dueDate} · Ransomware use: ${item.ransomware}`;
      card.append(dates);
      if (item.forensicTriage)
        card.append(
          element(
            this.document,
            'p',
            'cyber-kev-meta',
            'CISA forensic triage requirements apply.',
          ),
        );
      const action = element(this.document, 'details', 'cyber-kev-action');
      action.append(element(this.document, 'summary', '', 'Required action'));
      action.append(element(this.document, 'p', '', item.requiredAction));
      card.append(action);
      const link = element(
        this.document,
        'a',
        'cyber-kev-source-link',
        'CISA KEV catalog ↗',
      );
      link.href =
        'https://www.cisa.gov/known-exploited-vulnerabilities-catalog';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.append(link);
      results.append(card);
    }
    if (matches.length > this._kevVisibleCount) {
      const more = element(
        this.document,
        'button',
        'cyber-kev-more',
        `Show next ${Math.min(25, matches.length - this._kevVisibleCount)} vulnerabilities`,
      );
      more.type = 'button';
      more.dataset.kevMore = 'true';
      results.append(more);
    }
    section.append(results);
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-attribution',
        `${snapshot.attribution} · fetched ${snapshot.fetchedAt}`,
      ),
    );
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
      const otxButton = element(this.document, 'button', '', 'OTX context');
      otxButton.type = 'button';
      otxButton.dataset.otxLookup = 'true';
      otxButton.dataset.indicator = selection.ip;
      section.append(otxButton);
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
      const kevMatches = selection.kevMatches || [];
      section.append(
        element(
          this.document,
          'h4',
          '',
          `CISA KEV matches · ${kevMatches.length}`,
        ),
      );
      if (kevMatches.length) {
        for (const item of kevMatches) {
          const match = element(this.document, 'p', 'cyber-intel-detail-row');
          match.append(
            element(this.document, 'strong', '', `${item.cveId} · `),
          );
          match.append(
            this.document.createTextNode(
              `${item.vendor} ${item.product} · CISA due ${item.dueDate}`,
            ),
          );
          section.append(match);
        }
      } else {
        section.append(
          element(
            this.document,
            'p',
            'cyber-intel-provenance',
            !selection.kevCatalogAvailable
              ? 'CISA KEV is unavailable, so matches could not be checked.'
              : selection.reportedCves?.length
                ? 'Shodan reported CVE identifiers, but none match the current CISA KEV catalog.'
                : 'Shodan did not report CVE identifiers for this device.',
          ),
        );
      }
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-provenance',
          'Matches use explicit CVE identifiers reported by Shodan banners. They do not confirm the device remains vulnerable.',
        ),
      );
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
    if (provider.id === 'dshield')
      section.append(
        element(this.document, 'h3', '', 'Top Attackers & Target Ports'),
      );
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
        const otxButton = element(this.document, 'button', '', 'OTX context');
        otxButton.type = 'button';
        otxButton.dataset.otxLookup = 'true';
        otxButton.dataset.indicator = record.indicator?.value || '';
        if (
          record.indicator?.type === 'ipv4' ||
          record.indicator?.type === 'ipv6'
        )
          actions.append(otxButton);
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
            const result = this._renderEnrichment(
              value,
              source,
              pending,
              provider.kevSnapshot,
            );
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
    return section;
  }

  _renderOtxLookup(state) {
    const section = element(this.document, 'section', 'cyber-intel-provider');
    section.append(element(this.document, 'h3', '', 'AlienVault OTX'));
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-provenance',
        'Look up an IP, domain, URL, file hash, or CVE. Each lookup sends that indicator to OTX. A match is threat-intelligence context, not proof of compromise; OTX indicators do not create map locations.',
      ),
    );
    const form = element(this.document, 'form', 'cyber-intel-search-form');
    form.dataset.otxSearch = 'true';
    const input = element(this.document, 'input');
    input.type = 'search';
    input.name = 'otx-indicator';
    input.maxLength = 2048;
    input.placeholder = 'IP, domain, URL, hash, or CVE';
    input.setAttribute('aria-label', 'AlienVault OTX indicator');
    const submit = element(
      this.document,
      'button',
      '',
      state.selectedOtxKey && state.otxPending?.includes(state.selectedOtxKey)
        ? 'Looking up…'
        : 'OTX Lookup',
    );
    submit.type = 'submit';
    submit.disabled =
      !!state.selectedOtxKey &&
      state.otxPending?.includes(state.selectedOtxKey);
    form.append(input, submit);
    section.append(form);
    const result = state.selectedOtxKey
      ? state.otxResults?.[state.selectedOtxKey]
      : null;
    const pending =
      state.selectedOtxKey && state.otxPending?.includes(state.selectedOtxKey);
    if (pending)
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-empty',
          'Querying AlienVault OTX…',
        ),
      );
    else if (result?.error)
      section.append(
        element(this.document, 'p', 'cyber-intel-empty', result.error),
      );
    else if (result) {
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-provenance',
          `${result.indicatorTypeLabel} · ${result.indicator} · ${result.pulseCount} associated pulse${result.pulseCount === 1 ? '' : 's'}${result.fetchedAt ? ` · ${result.fetchedAt}` : ''}`,
        ),
      );
      if (!result.pulses?.length)
        section.append(
          element(
            this.document,
            'p',
            'cyber-intel-empty',
            'No subscribed OTX pulse associations were returned.',
          ),
        );
      for (const pulse of result.pulses || []) {
        const card = element(this.document, 'article', 'cyber-kev-entry');
        card.append(element(this.document, 'h4', '', pulse.name));
        const metadata = [
          pulse.author,
          pulse.modified,
          pulse.indicatorCount ? `${pulse.indicatorCount} indicators` : null,
          pulse.tlp,
        ]
          .filter(Boolean)
          .join(' · ');
        if (metadata)
          card.append(element(this.document, 'p', 'cyber-kev-meta', metadata));
        if (pulse.description)
          card.append(
            element(
              this.document,
              'p',
              'cyber-kev-description',
              pulse.description,
            ),
          );
        if (pulse.tags?.length)
          card.append(
            element(
              this.document,
              'p',
              'cyber-kev-meta',
              `Tags: ${pulse.tags.join(', ')}`,
            ),
          );
        const link = element(
          this.document,
          'a',
          'cyber-kev-source-link',
          'Open OTX pulse ↗',
        );
        link.href = `https://otx.alienvault.com/pulse/${encodeURIComponent(pulse.id)}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.append(link);
        section.append(card);
      }
      const sourceLink = element(
        this.document,
        'a',
        'cyber-kev-source-link',
        'Open OTX indicator ↗',
      );
      sourceLink.href = result.link;
      sourceLink.target = '_blank';
      sourceLink.rel = 'noopener noreferrer';
      section.append(sourceLink);
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-attribution',
          result.attribution,
        ),
      );
    }
    return section;
  }

  _renderLegend() {
    const legend = element(this.document, 'section', 'cyber-intel-legend');
    legend.setAttribute('aria-label', 'Cyber map legend');
    legend.append(element(this.document, 'h3', '', 'CloudFlare Radar'));
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
      this._renderLegendExplainer(
        'About CloudFlare Radar',
        'Radar positions are country reference anchors. Arrows show only the top 10 pairs Cloudflare reports; a dot without a line has no pair in that set. Arrows show aggregate associations, not network routes.',
      ),
    );
    legend.append(element(this.document, 'h3', '', 'Shodan'));
    const shodanRow = element(this.document, 'p', 'cyber-intel-legend-row');
    shodanRow.append(element(this.document, 'span', 'cyber-legend-shodan'));
    shodanRow.append(
      this.document.createTextNode('Gold dot · searched Shodan device'),
    );
    legend.append(shodanRow);
    legend.append(
      this._renderLegendExplainer(
        'About Shodan',
        'Shodan devices appear after an area search; IP-based positions are approximate network locations.',
      ),
    );
    return legend;
  }

  _renderLegendExplainer(summary, explanation) {
    const details = element(this.document, 'details', 'cyber-legend-explainer');
    details.append(element(this.document, 'summary', '', summary));
    details.append(
      element(this.document, 'p', 'cyber-intel-provenance', explanation),
    );
    return details;
  }

  render(state) {
    if (!this.panel || !this.body) return;
    const shodanResults = this.body.querySelector?.('[data-shodan-results]');
    const kevResults = this.body.querySelector?.('[data-kev-results]');
    if (shodanResults) this._shodanResultsOpen = shodanResults.open;
    if (kevResults) this._kevResultsOpen = kevResults.open;
    this._lastState = state;
    const isEnabled = state?.enabled === true;
    const becameEnabled = isEnabled && !this._wasEnabled;
    this._wasEnabled = isEnabled;
    this.panel.hidden = !isEnabled;
    this.panel.setAttribute('aria-hidden', String(!isEnabled));
    this.panel.inert = !isEnabled;
    if (this.legendPanel) {
      this.legendPanel.hidden = !isEnabled;
      this.legendPanel.inert = !isEnabled;
    }
    this.legendContent?.replaceChildren();
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

    this.body.append(this._renderShodanSearch(state));
    this.body.append(this._renderKevCatalog(state));
    this.legendContent?.append(this._renderLegend());

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
    this.body.append(this._renderOtxLookup(state));
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
    if (this._onPanelClick)
      this.panel?.removeEventListener('click', this._onPanelClick);
    if (this._onLegendClick)
      this.legendPanel?.removeEventListener('click', this._onLegendClick);
    if (this._onDevicePopupClick)
      this.devicePopup?.removeEventListener('click', this._onDevicePopupClick);
    this._onBodyClick = null;
    this._onBodySubmit = null;
    this._onPanelClick = null;
    this._onLegendClick = null;
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

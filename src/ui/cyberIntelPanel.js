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
      }
    };
    this._onBodySubmit = (event) => {
      const form = event.target?.closest?.('[data-shodan-search]');
      if (!form) return;
      event.preventDefault();
      const query = form.querySelector('input[name="query"]')?.value?.trim();
      if (query) void layer.getThreatIntelState().onShodanSearch?.(query, 1);
    };
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
    section.append(element(this.document, 'h3', '', 'Optional Shodan search'));
    section.append(
      element(
        this.document,
        'p',
        'cyber-intel-provenance',
        'Search only runs when submitted. Shodan search filters and pages after the first may use query credits; an unfiltered first page does not. Results are capped at 10 per page. Check your account plan and remaining credits in Provider Settings before searching.',
      ),
    );
    const form = element(this.document, 'form', 'cyber-intel-search-form');
    form.dataset.shodanSearch = 'true';
    const input = element(this.document, 'input');
    input.name = 'query';
    input.type = 'search';
    input.maxLength = 120;
    input.placeholder = 'e.g. port:443 country:US';
    input.setAttribute('aria-label', 'Shodan search query');
    input.value = state.shodanSearch?.query || '';
    const submit = element(this.document, 'button', '', 'Search Shodan');
    submit.type = 'submit';
    form.append(input, submit);
    section.append(form);
    const search = state.shodanSearch;
    if (!search) return section;
    if (search.loading) {
      section.append(
        element(this.document, 'p', 'cyber-intel-empty', 'Searching Shodan…'),
      );
      return section;
    }
    if (search.error)
      section.append(
        element(this.document, 'p', 'cyber-intel-empty', search.error),
      );
    else {
      section.append(
        element(
          this.document,
          'p',
          'cyber-intel-provenance',
          `${search.total ?? 'Some'} matches · page ${search.page} · ${search.attribution}`,
        ),
      );
      for (const result of search.matches || []) {
        const row = element(this.document, 'div', 'cyber-intel-search-result');
        row.append(element(this.document, 'strong', '', result.ip));
        row.append(
          element(
            this.document,
            'span',
            '',
            [
              result.organization,
              result.services?.[0]?.port
                ? `port ${result.services[0].port}`
                : null,
            ]
              .filter(Boolean)
              .join(' · '),
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
      const nextPage = Number(search.page) + 1;
      if (search.total > search.page * 100 && nextPage <= 3) {
        const more = element(
          this.document,
          'button',
          '',
          `More results · page ${nextPage} may cost query credits`,
        );
        more.type = 'button';
        more.dataset.shodanPage = String(nextPage);
        more.dataset.query = search.query;
        section.append(more);
      }
    }
    return section;
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
      for (const label of ['IP Address', 'Domain Name', 'On-demand enrichment'])
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
        const actions = element(this.document, 'td', 'cyber-intel-actions');
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
        row.append(actions);
        body.append(row);
        for (const source of ['shodan', 'greynoise']) {
          const key = `${source}:${record.indicator?.value}`;
          const value = provider.enrichmentResults?.[key];
          const pending = provider.enrichmentPending?.includes(key);
          if (value || pending) {
            const result = this._renderEnrichment(value, source, pending);
            const resultRow = element(this.document, 'tr');
            const cell = element(this.document, 'td');
            cell.setAttribute('colspan', '3');
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
    this._onBodyClick = null;
    this._onBodySubmit = null;
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

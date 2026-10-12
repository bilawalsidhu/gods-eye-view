const clean = (value) =>
  Array.isArray(value)
    ? value.join(', ') || 'Unknown'
    : value === null || value === undefined || value === ''
      ? 'Unknown'
      : String(value).slice(0, 1200);
export function infrastructureDetailRows(record) {
  const p = record?.properties || {};
  if (p.type === 'Approximate geographic cluster')
    return [
      ['Type', p.type],
      ['Source records', clean(p.records)],
      [
        'Position',
        'Representative cluster location; zoom in for individual records.',
      ],
    ];
  return [
    ['Owner (source reported)', clean(p.owner)],
    ['Site operator (source reported)', clean(p.operator)],
    ['Mapped network/carrier tag', clean(p.network)],
    ['Hosted cellular carriers/tenants', clean(p.hostedCarriers)],
    ['Documented mapped technology', clean(p.technologies)],
    ...(record?.layerId === 'mapped-telecom-lines'
      ? [
          ['Mapped medium', clean(p.medium)],
          [
            'Connectivity',
            'No junctions or outage/service dependencies inferred from crossings or proximity.',
          ],
        ]
      : []),
    ...(p.capacityMw !== undefined
      ? [
          [
            'Nameplate capacity',
            `${clean(p.capacityMw)} MW (not current generation)`,
          ],
          ['Inventory statuses', clean(p.statuses)],
          ['Generator rows', clean(p.generatorCount)],
        ]
      : []),
    ['Source/date', `${clean(p.source || record?.source)} · ${clean(p.date)}`],
    ['License', clean(p.license)],
    ['Coverage', clean(p.sourceCoverage)],
  ];
}
let dialog, selectedLayer;
/** One bounded page-owned modal, created only after an infrastructure click. */
export function showInfrastructureDetails(record) {
  if (!record || typeof document === 'undefined') return;
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'public-infrastructure-detail';
    dialog.setAttribute('aria-labelledby', 'public-infrastructure-title');
    dialog.innerHTML =
      '<header><h2 id="public-infrastructure-title"></h2><button type="button" aria-label="Close infrastructure details">CLOSE</button></header><p class="infra-source-label"></p><p>Mapped metadata is incomplete. Owner, site operator, network and hosted carriers are different fields. Unknown is not absence. Mapped technology is not verified service coverage.</p><dl></dl><a class="infra-record-link" target="_blank" rel="noopener noreferrer">Open source record</a>';
    dialog
      .querySelector('button')
      .addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dialog.close();
      }
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dialog.close();
    });
    document.body.append(dialog);
  }
  selectedLayer = record.layerId;
  dialog.querySelector('h2').textContent =
    record.label || record.layerName || 'Mapped infrastructure';
  dialog.querySelector('.infra-source-label').textContent =
    record.layerName || record.layerId;
  const list = dialog.querySelector('dl');
  list.replaceChildren();
  for (const [label, value] of infrastructureDetailRows(record)) {
    const term = document.createElement('dt'),
      definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value;
    list.append(term, definition);
  }
  const link = dialog.querySelector('a');
  let source;
  try {
    const u = new URL(record.properties?.sourceUrl);
    if (
      u.protocol === 'https:' &&
      ['www.openstreetmap.org', 'www.eia.gov'].includes(u.hostname)
    )
      source = u.href;
  } catch {
    /* source unknown */
  }
  link.hidden = !source;
  if (source) link.href = source;
  else link.removeAttribute('href');
  const parent = document.fullscreenElement || document.body;
  if (dialog.parentNode !== parent) parent.append(dialog);
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('button').focus({ preventScroll: true });
}
export function hideInfrastructureDetailsForLayer(layerId) {
  if (selectedLayer === layerId && dialog?.open) dialog.close();
}

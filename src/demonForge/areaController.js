import { appendLedgerEvent } from './ledger.js';
import {
  validateInvestigationArea,
  queryInvestigationArea,
  appendInvestigationEntry,
  encryptInvestigationBackup,
  decryptInvestigationBackup,
} from './areaInvestigation.js';

const COPY = {
  en: {
    title: 'INVESTIGATE THIS AREA',
    intro:
      'Public location queries only. Coordinates and radius are sent to existing providers when you run a query. Notes and case data stay encrypted locally. Source coverage is limited; retrieval time is not observation time.',
    unlock: 'Unlock vault',
    create: 'Create area case',
    use: 'Use observed globe center',
    query: 'Query selected sources',
    save: 'Record evidence',
    backup: 'Download encrypted backup',
    restore: 'Restore as a new case',
    remove: 'Delete current case',
    close: 'Close and lock',
    ready: 'Area vault authenticated.',
    locked: 'Area workspace locked.',
    saved: 'Evidence saved locally.',
    created: 'Area case created.',
    restored: 'Backup restored as a new case.',
    deleted: 'Case deleted.',
    failed: 'Action failed; nothing reported as successful.',
    open: 'Open case',
    source: 'Selected sources',
    note: 'Evidence text',
    confidence: 'Confidence is an operator assessment, not a source score.',
    period:
      'Sources use their stated coverage; arbitrary historical periods are not supported.',
    empty:
      'No rows returned within this source coverage. This is not proof of absence.',
  },
  fr: {
    title: 'ENQUÊTER SUR CETTE ZONE',
    intro:
      'Requêtes publiques sur les lieux uniquement. Les coordonnées et le rayon sont transmis aux fournisseurs existants lors de la requête. Les notes et dossiers restent chiffrés localement. La date de consultation ne remplace pas la date d’observation.',
    unlock: 'Déverrouiller le coffre',
    create: 'Créer un dossier de zone',
    use: 'Utiliser le centre du globe observé',
    query: 'Interroger les sources sélectionnées',
    save: 'Enregistrer la preuve',
    backup: 'Télécharger la sauvegarde chiffrée',
    restore: 'Restaurer dans un nouveau dossier',
    remove: 'Supprimer le dossier courant',
    close: 'Fermer et verrouiller',
    ready: 'Coffre de zone authentifié.',
    locked: 'Espace de zone verrouillé.',
    saved: 'Preuve enregistrée localement.',
    created: 'Dossier de zone créé.',
    restored: 'Sauvegarde restaurée dans un nouveau dossier.',
    deleted: 'Dossier supprimé.',
    failed: 'Échec de l’action ; aucun succès annoncé.',
    open: 'Ouvrir le dossier',
    source: 'Sources sélectionnées',
    note: 'Texte de la preuve',
    confidence:
      'La confiance est une appréciation humaine, pas un score du fournisseur.',
    period:
      'Les sources utilisent leur période annoncée ; pas de recherche historique arbitraire.',
    empty:
      'Aucun résultat dans la couverture de cette source. Cela ne prouve pas une absence.',
  },
};

/** Own the independent area vault and cancel/scrub async work when it closes. */
export function initAreaWorkspace({
  document,
  vault,
  getArea,
  loadCatalog,
  now = Date.now,
  createId = () => crypto.randomUUID(),
}) {
  const el = (id) => document.getElementById(`area-${id}`);
  const dialog = el('dialog');
  let record = null,
    epoch = 0,
    controller = null,
    busy = false,
    language = 'en',
    background = null;
  const listeners = [];
  const copy = () => COPY[language];
  const status = (message) => {
    el('status').textContent = message;
  };
  function listen(id, name, handler) {
    const node = el(id);
    node.addEventListener(name, handler);
    listeners.push(() => node.removeEventListener(name, handler));
  }
  function translate() {
    language = el('language').value === 'fr' ? 'fr' : 'en';
    for (const node of dialog.querySelectorAll('[data-area-copy]'))
      node.textContent = copy()[node.dataset.areaCopy];
    dialog.lang = language;
  }
  function readArea() {
    if (!el('lat').value.trim() || !el('lon').value.trim())
      throw new TypeError('Coordinates are required.');
    return validateInvestigationArea({
      lat: Number(el('lat').value),
      lon: Number(el('lon').value),
      radius_km: Number(el('radius').value),
    });
  }
  function showArea(area) {
    el('lat').value = area.lat;
    el('lon').value = area.lon;
    el('radius').value = area.radius_km;
  }
  function render() {
    el('history').replaceChildren();
    for (const entry of record?.workflow ?? []) {
      const item = document.createElement('li');
      const text = document.createElement('pre');
      text.className = 'demon-forge-personal-text';
      text.textContent = `${new Date(entry.atMs).toISOString()} · ${entry.kind} · ${entry.confidence}\n${entry.text}`;
      item.append(text);
      if (entry.snapshot) {
        const link = document.createElement('a');
        if (
          [
            'https://earthquake.usgs.gov/',
            'https://www.openstreetmap.org/copyright',
            'https://hls.gsfc.nasa.gov/',
          ].includes(entry.snapshot.sourceUrl)
        ) {
          link.href = entry.snapshot.sourceUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = entry.snapshot.source;
          item.append(link);
        }
        const details = document.createElement('pre');
        details.className = 'demon-forge-personal-text';
        const snapshot = entry.snapshot;
        const snapshotText = [
          snapshot.coverage,
          `${language === 'fr' ? 'Consulté' : 'Retrieved'}: ${new Date(snapshot.retrievedAtMs).toISOString()}`,
          `${language === 'fr' ? 'Date source' : 'Source date'}: ${snapshot.observedAt ?? (language === 'fr' ? 'inconnue' : 'unknown')}`,
          `${language === 'fr' ? 'Disponibilité' : 'Availability'}: ${snapshot.status}`,
          snapshot.attribution ?? '',
          snapshot.stale ? 'STALE / ANCIEN' : '',
          snapshot.truncated
            ? 'Partial list / Liste partielle (25 rows maximum)'
            : '',
          ...(snapshot.rows ?? []).map((row) =>
            Object.entries(row)
              .filter(([, value]) => value !== null)
              .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`)
              .join(' · '),
          ),
          snapshot.image
            ? `${snapshot.image.sensor} · ${snapshot.image.day} · ${snapshot.image.quality}`
            : '',
          snapshot.status === 'available' &&
          !snapshot.rows?.length &&
          !snapshot.image
            ? copy().empty
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        details.textContent = snapshotText;
        item.append(details);
      }
      el('history').append(item);
    }
  }
  function scrub() {
    record = null;
    controller?.abort();
    controller = null;
    epoch++;
    el('history').replaceChildren();
    el('cases').replaceChildren();
    for (const id of [
      'passphrase',
      'backup-passphrase',
      'note',
      'title',
      'lat',
      'lon',
      'restore-file',
    ])
      el(id).value = '';
  }
  function open() {
    if (!dialog.hidden) return;
    dialog.hidden = false;
    background = new Map();
    for (const child of document.body.children)
      if (child !== dialog) {
        background.set(child, child.inert);
        child.inert = true;
      }
    el('close').focus();
    translate();
    try {
      showArea(getArea(Number(el('radius').value)));
    } catch {
      status(copy().failed);
    }
  }
  function close() {
    dialog.hidden = true;
    scrub();
    void vault.lock();
    for (const [node, inert] of background ?? []) node.inert = inert;
    background = null;
    el('open').focus();
    status(copy().locked);
  }
  async function action(operation) {
    if (busy) return;
    busy = true;
    const generation = epoch;
    const controls = [
      ...dialog.querySelectorAll('button,input,select,textarea'),
    ].filter((node) => node !== el('close'));
    controls.forEach((node) => {
      node.disabled = true;
    });
    const current = () => {
      if (generation !== epoch || dialog.hidden)
        throw new Error('Workspace closed.');
    };
    try {
      await operation(current);
    } catch {
      if (generation === epoch) status(copy().failed);
    } finally {
      busy = false;
      controls.forEach((node) => {
        node.disabled = false;
      });
    }
  }
  async function refreshCases(current) {
    const summaries = await vault.listCaseSummaries();
    current();
    el('cases').replaceChildren();
    for (const summary of summaries) {
      const option = document.createElement('option');
      option.value = summary.id;
      option.textContent = summary.id;
      el('cases').append(option);
    }
  }
  async function save(next, current) {
    current();
    await vault.saveCase(next);
    current();
    record = next;
    render();
  }
  listen('open', 'click', open);
  listen('close', 'click', close);
  listen('language', 'change', translate);
  listen('dialog', 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Tab') {
      const nodes = [
        ...dialog.querySelectorAll('button,input,select,textarea,a[href]'),
      ].filter((node) => !node.disabled && !node.hidden);
      const first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  listen('unlock', 'click', () =>
    action(async (current) => {
      await vault.unlock(el('passphrase').value);
      current();
      el('passphrase').value = '';
      await refreshCases(current);
      status(copy().ready);
    }),
  );
  listen('use', 'click', () => {
    try {
      showArea(getArea(Number(el('radius').value)));
    } catch {
      status(copy().failed);
    }
  });
  listen('create', 'click', () =>
    action(async (current) => {
      const area = readArea();
      const id = createId();
      const next = {
        id,
        kind: 'area-investigation',
        title: el('title').value.trim().slice(0, 200),
        area,
        status: 'open',
        workflow: [],
        ledger: appendLedgerEvent(
          [],
          { type: 'AREA_CASE_CREATED', actor: 'operator', payload: { area } },
          now(),
        ),
      };
      await vault.saveCase(next, { create: true });
      current();
      record = next;
      render();
      await refreshCases(current);
      status(copy().created);
    }),
  );
  listen('case-open', 'click', () =>
    action(async (current) => {
      const next = await vault.loadCase(el('cases').value);
      current();
      if (next?.kind !== 'area-investigation') throw new Error('Invalid case.');
      record = next;
      showArea(record.area);
      el('title').value = record.title;
      render();
      status(copy().ready);
    }),
  );
  listen('query', 'click', () =>
    action(async (current) => {
      if (!record) throw new Error('Create or open an area case first.');
      const area = readArea();
      const ids = [...dialog.querySelectorAll('[data-area-source]')]
        .filter((node) => node.checked)
        .map((node) => node.value);
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 30000);
      try {
        const catalog = await loadCatalog();
        current();
        const snapshots = await queryInvestigationArea({
          catalog,
          area,
          sourceIds: ids,
          signal: controller.signal,
          now,
        });
        current();
        let next = record;
        for (const snapshot of snapshots)
          next = appendInvestigationEntry(
            next,
            { kind: 'observation', text: snapshot.summary, snapshot },
            now(),
          );
        await save(next, current);
        status(copy().saved);
      } finally {
        clearTimeout(timer);
        controller = null;
      }
    }),
  );
  listen('save', 'click', () =>
    action(async (current) => {
      if (!record) throw new Error('Case required.');
      const next = appendInvestigationEntry(
        record,
        {
          kind: el('kind').value,
          text: el('note').value,
          confidence: el('confidence').value,
        },
        now(),
      );
      await save(next, current);
      el('note').value = '';
      status(copy().saved);
    }),
  );
  listen('backup', 'click', () =>
    action(async (current) => {
      if (!record) throw new Error('Case required.');
      const backup = await encryptInvestigationBackup(
        record,
        el('backup-passphrase').value,
      );
      current();
      el('backup-passphrase').value = '';
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'area-case.encrypted.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(copy().saved);
    }),
  );
  listen('restore', 'click', () =>
    action(async (current) => {
      const file = el('restore-file').files?.[0];
      if (!file || file.size > 8 * 1024 * 1024)
        throw new Error('Backup limit is 8 MiB.');
      const value = await file.text();
      current();
      const restored = await decryptInvestigationBackup(
        value,
        el('backup-passphrase').value,
      );
      current();
      el('backup-passphrase').value = '';
      const next = { ...restored, id: createId(), restoredAtMs: now() };
      await vault.saveCase(next, { create: true });
      current();
      record = next;
      showArea(record.area);
      el('title').value = record.title ?? '';
      render();
      await refreshCases(current);
      status(copy().restored);
    }),
  );
  listen('remove', 'click', () =>
    action(async (current) => {
      if (!record) throw new Error('Case required.');
      await vault.deleteCase(record.id);
      current();
      record = null;
      render();
      await refreshCases(current);
      status(copy().deleted);
    }),
  );
  translate();
  return {
    open,
    close,
    destroy() {
      close();
      listeners.splice(0).forEach((remove) => remove());
    },
  };
}

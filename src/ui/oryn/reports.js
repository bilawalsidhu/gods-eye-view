// ORYN report assembly and export. Exports are real files (JSON and CSV)
// built from records the prototype actually holds. PDF export is not
// implemented: it would need a new dependency, so the UI says so.

/**
 * Assemble a report document for an investigation.
 * @param {object} investigation Validated investigation record
 * @param {{notes?:object[],scenes?:object[],feeds?:object[],session?:object,generatedAt?:string}} context
 */
export function buildInvestigationReport(
  investigation,
  { notes = [], scenes = [], feeds = [], session = null, generatedAt } = {},
) {
  if (!investigation?.id) throw new TypeError('An investigation is required');
  const relatedNotes = notes.filter(
    (note) => note.investigationId === investigation.id,
  );
  const relatedScenes = scenes.filter((scene) =>
    investigation.sceneIds.includes(scene.id),
  );
  return {
    format: 'oryn-investigation-report',
    version: 1,
    generatedAt: generatedAt || new Date().toISOString(),
    prototype: true,
    organization: session
      ? { id: session.organizationId, name: session.organization, demo: true }
      : null,
    investigation: {
      id: investigation.id,
      title: investigation.title,
      summary: investigation.summary,
      status: investigation.status,
      createdAt: investigation.createdAt,
      updatedAt: investigation.updatedAt,
    },
    entities: investigation.entities.map((entity) => ({
      kind: entity.kind,
      id: entity.id,
      label: entity.label ?? null,
      layerId: entity.layerId ?? null,
      longitude: entity.position?.lon ?? null,
      latitude: entity.position?.lat ?? null,
      source: entity.source ?? null,
      sourceUrl: entity.sourceUrl ?? null,
      observedAt: entity.observedAt ?? null,
      retrievedAt: entity.retrievedAt ?? null,
      provenance: entity.provenance,
      fields: entity.fields ?? {},
    })),
    timeline: investigation.timeline.map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      provenance: entry.provenance,
      text: entry.text,
    })),
    notes: relatedNotes.map((note) => ({
      id: note.id,
      createdAt: note.createdAt,
      author: note.author,
      provenance: note.provenance,
      body: note.body,
      longitude: note.position?.lon ?? null,
      latitude: note.position?.lat ?? null,
      target: note.target
        ? { kind: note.target.kind, id: note.target.id }
        : null,
    })),
    scenes: relatedScenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      camera: scene.camera,
      enabledLayers: scene.enabledLayers,
      mode: scene.mode,
      createdAt: scene.createdAt,
    })),
    dataSources: feeds.map((feed) => ({
      id: feed.id,
      name: feed.name,
      source: feed.source,
      state: feed.state,
      lastRetrievedAt: feed.lastUpdate
        ? new Date(feed.lastUpdate).toISOString()
        : null,
      error: feed.error ?? null,
    })),
    limitations: [
      'This report was produced by a local prototype. Records are stored in the analyst browser and are not shared with an organization backend.',
      'Provider-reported values are reproduced as received; observation and retrieval times are listed separately where known.',
      'No model-generated findings are included because no inference backend is configured.',
      'Public feeds are refreshed periodically; they are not continuous surveillance and coverage is not universal.',
    ],
  };
}

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  const needsQuotes = /[",\r\n]/.test(text);
  const escaped = text.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

/** Rows (array of plain objects) to RFC 4180-style CSV text. */
export function toCsv(rows, columns) {
  const headers =
    columns ??
    [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(Boolean);
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows)
    lines.push(headers.map((key) => csvEscape(row[key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** The entity table of a report as CSV. */
export function reportEntitiesCsv(report) {
  return toCsv(report.entities, [
    'kind',
    'id',
    'label',
    'layerId',
    'longitude',
    'latitude',
    'source',
    'sourceUrl',
    'observedAt',
    'retrievedAt',
    'provenance',
  ]);
}

/** Events from the triage queue as CSV. */
export function eventsCsv(events) {
  return toCsv(
    events.map((event) => ({
      layerId: event.layerId,
      id: event.id,
      label: event.label,
      longitude: event.lon,
      latitude: event.lat,
      observedAt: event.observedAt ?? '',
      retrievedAt: event.retrievedAt ?? '',
      source: event.source ?? '',
      sourceUrl: event.sourceUrl ?? '',
      ...event.fields,
    })),
  );
}

export function safeFileName(text, extension) {
  const base =
    String(text || 'oryn-export')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'oryn-export';
  return `${base}.${extension}`;
}

/** Trigger a browser download for text content. */
export function downloadText(
  fileName,
  text,
  mimeType,
  { documentRef = globalThis.document, urlRef = globalThis.URL } = {},
) {
  if (!documentRef?.createElement || !urlRef?.createObjectURL)
    throw new Error('Downloads are unavailable in this environment');
  const blob = new Blob([text], { type: mimeType });
  const url = urlRef.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => urlRef.revokeObjectURL(url), 1000);
}

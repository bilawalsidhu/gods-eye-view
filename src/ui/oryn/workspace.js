// The analyst workspace: scenes, investigations and notes, stored locally
// through the validated collections in store.js. Helpers here are the only
// writers; UI modules call them and re-render from the collections.
import { t } from '../../i18n/index.js';
import { createCollection, newId } from './store.js';
import {
  validateInvestigation,
  validateNote,
  validateScene,
  validateTimelineEntry,
} from './models.js';

export function createWorkspace({ storage, session } = {}) {
  const scenes = createCollection('scenes', validateScene, { storage });
  const investigations = createCollection(
    'investigations',
    validateInvestigation,
    { storage },
  );
  const notes = createCollection('notes', validateNote, { storage });
  const audit = createCollection(
    'audit',
    (value) =>
      value && typeof value.action === 'string' && value.at
        ? {
            id: value.id || newId('audit'),
            at: value.at,
            actor: String(value.actor || 'analyst').slice(0, 160),
            action: value.action.slice(0, 120),
            subject: String(value.subject || '').slice(0, 300),
          }
        : null,
    { storage },
  );

  const organizationId = () => session?.current()?.organizationId ?? null;
  const actor = () => session?.current()?.user ?? 'analyst';

  function record(action, subject) {
    try {
      audit.put({
        id: newId('audit'),
        at: new Date().toISOString(),
        actor: actor(),
        action,
        subject,
      });
    } catch {
      // The audit trail is best-effort in the prototype.
    }
  }

  function touch(value) {
    return { ...value, updatedAt: new Date().toISOString() };
  }

  return Object.freeze({
    scenes,
    investigations,
    notes,
    audit,
    record,

    // ── Scenes ──────────────────────────────────────────────────────────
    saveScene(engine, { name, mode, selection, panels, investigationId, id }) {
      const camera = engine.getCameraState();
      if (!camera)
        throw new Error(t('The camera position is not available yet'));
      const scene = scenes.put({
        id,
        name,
        organizationId: organizationId(),
        camera: {
          position: { lon: camera.lon, lat: camera.lat, height: camera.alt },
          heading: camera.heading,
          pitch: camera.pitch,
          roll: camera.roll,
        },
        enabledLayers: engine.dataManager.getEnabledLayerIds(),
        mode,
        selection,
        panels,
        investigationId: investigationId || null,
        createdAt: id ? scenes.get(id)?.createdAt : undefined,
        updatedAt: new Date().toISOString(),
      });
      record(id ? 'scene.update' : 'scene.create', scene.name);
      return scene;
    },
    async applyScene(engine, scene) {
      const camera = scene.camera;
      engine.applyCameraState(
        {
          lat: camera.position.lat,
          lon: camera.position.lon,
          alt: camera.position.height,
          heading: camera.heading,
          pitch: camera.pitch,
          roll: camera.roll,
        },
        2.2,
      );
      const wanted = new Set(scene.enabledLayers);
      const known = new Set(engine.dataManager.getAll().map((row) => row.id));
      const missing = scene.enabledLayers.filter((id) => !known.has(id));
      const work = [];
      for (const row of engine.dataManager.getAll()) {
        if (row.showInTogglePanel === false) continue;
        const shouldEnable = wanted.has(row.id);
        if (shouldEnable !== row.enabled)
          work.push(
            engine
              .setLayerEnabled(row.id, shouldEnable)
              .catch((error) =>
                console.warn(`[ORYN] scene layer ${row.id}`, error),
              ),
          );
      }
      await Promise.all(work);
      record('scene.open', scene.name);
      return { missingLayers: missing };
    },
    renameScene(id, name) {
      const scene = scenes.get(id);
      if (!scene) return null;
      const next = scenes.put(touch({ ...scene, name }));
      record('scene.rename', next.name);
      return next;
    },
    duplicateScene(id) {
      const scene = scenes.get(id);
      if (!scene) return null;
      const copy = scenes.put({
        ...scene,
        id: newId('scene'),
        name: t('{name} (copy)', { name: scene.name }),
        createdAt: undefined,
        updatedAt: undefined,
      });
      record('scene.duplicate', copy.name);
      return copy;
    },
    deleteScene(id) {
      const scene = scenes.get(id);
      const removed = scenes.remove(id);
      if (removed) record('scene.delete', scene?.name || id);
      return removed;
    },

    // ── Investigations ──────────────────────────────────────────────────
    createInvestigation({ title, summary = '' }) {
      const investigation = investigations.put({
        title,
        summary,
        status: 'open',
        organizationId: organizationId(),
        owner: actor(),
        entities: [],
        timeline: [
          validateTimelineEntry({
            at: new Date().toISOString(),
            kind: 'status',
            provenance: 'analyst',
            text: t('Investigation opened'),
          }),
        ],
        sceneIds: [],
      });
      record('investigation.create', investigation.title);
      return investigation;
    },
    updateInvestigation(id, patch) {
      const current = investigations.get(id);
      if (!current) return null;
      const next = investigations.put(touch({ ...current, ...patch, id }));
      record('investigation.update', next.title);
      return next;
    },
    setInvestigationStatus(id, status) {
      const current = investigations.get(id);
      if (!current) return null;
      const entry = validateTimelineEntry({
        at: new Date().toISOString(),
        kind: 'status',
        provenance: 'analyst',
        text: t('Status changed to {status}', { status }),
      });
      const next = investigations.put(
        touch({
          ...current,
          status,
          timeline: [...current.timeline, entry],
        }),
      );
      record('investigation.status', `${next.title}: ${status}`);
      return next;
    },
    addEntityToInvestigation(id, ref) {
      const current = investigations.get(id);
      if (!current || !ref) return null;
      if (
        current.entities.some(
          (entity) => entity.id === ref.id && entity.kind === ref.kind,
        )
      )
        return current;
      const entry = validateTimelineEntry({
        at: new Date().toISOString(),
        kind: 'evidence',
        provenance: ref.provenance || 'provider',
        text: t('Added {label}', { label: ref.label || ref.id }),
        ref,
      });
      const next = investigations.put(
        touch({
          ...current,
          entities: [...current.entities, ref],
          timeline: [...current.timeline, entry],
        }),
      );
      record('investigation.evidence', `${next.title}: ${ref.label || ref.id}`);
      return next;
    },
    removeEntityFromInvestigation(id, refId) {
      const current = investigations.get(id);
      if (!current) return null;
      return investigations.put(
        touch({
          ...current,
          entities: current.entities.filter((entity) => entity.id !== refId),
        }),
      );
    },
    attachScene(id, sceneId) {
      const current = investigations.get(id);
      if (!current || current.sceneIds.includes(sceneId)) return current;
      return investigations.put(
        touch({ ...current, sceneIds: [...current.sceneIds, sceneId] }),
      );
    },
    addTimelineNote(id, text) {
      const current = investigations.get(id);
      if (!current) return null;
      const entry = validateTimelineEntry({
        at: new Date().toISOString(),
        kind: 'note',
        provenance: 'analyst',
        text,
      });
      if (!entry) return current;
      return investigations.put(
        touch({ ...current, timeline: [...current.timeline, entry] }),
      );
    },
    deleteInvestigation(id) {
      const current = investigations.get(id);
      const removed = investigations.remove(id);
      if (removed) record('investigation.delete', current?.title || id);
      return removed;
    },

    // ── Notes ───────────────────────────────────────────────────────────
    addNote({ body, target, position, investigationId }) {
      const note = notes.put({
        body,
        author: actor(),
        target,
        position: position || target?.position || null,
        investigationId: investigationId || null,
      });
      record('note.create', note.target?.label || note.body.slice(0, 60));
      return note;
    },
    deleteNote(id) {
      const removed = notes.remove(id);
      if (removed) record('note.delete', id);
      return removed;
    },
    notesFor(ref) {
      if (!ref) return [];
      return notes
        .list()
        .filter(
          (note) =>
            note.target &&
            note.target.id === ref.id &&
            note.target.kind === ref.kind,
        );
    },
  });
}

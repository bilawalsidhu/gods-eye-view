// Investigations: create, review, edit and close analyst investigations held
// in the local workspace. Evidence rows keep their provenance label so
// provider-reported records, analyst notes and (absent) model findings are
// never mixed up.
import { t } from '../../i18n/index.js';
import { el, button, chip, emptyState, formatCoordinate } from './dom.js';
import { formatTimestamp, formatAge, provenanceLabel } from './provenance.js';
import { INVESTIGATION_STATUSES } from './models.js';
import { pageHead } from './pages.js';

function statusChip(status) {
  return chip(
    status === 'open'
      ? t('OPEN')
      : status === 'in-review'
        ? t('IN REVIEW')
        : t('CLOSED'),
    status === 'open' ? 'info' : status === 'in-review' ? 'warn' : 'neutral',
  );
}

function createForm(ctx) {
  const title = el('input', {
    className: 'oryn-input',
    attrs: {
      type: 'text',
      maxlength: 200,
      placeholder: t('Investigation title'),
      required: true,
    },
  });
  const summary = el('textarea', {
    className: 'oryn-textarea',
    attrs: { placeholder: t('Summary (optional)'), rows: 3 },
  });
  return el(
    'form',
    {
      className: 'oryn-card oryn-form',
      on: {
        submit: (event) => {
          event.preventDefault();
          const text = title.value.trim();
          if (!text) return;
          const investigation = ctx.workspace.createInvestigation({
            title: text,
            summary: summary.value.trim(),
          });
          ctx.toast(t('Investigation created'));
          ctx.navigate('investigations', { id: investigation.id });
        },
      },
    },
    el('h3', { className: 'oryn-card-title', text: t('New investigation') }),
    el('label', { attrs: { for: 'oryn-inv-title' }, text: t('Title') }),
    title,
    el('label', { text: t('Summary') }),
    summary,
    el(
      'div',
      { className: 'oryn-actions' },
      button({
        label: t('Create'),
        iconName: 'plus',
        className: 'oryn-btn-primary',
        type: 'submit',
      }),
      button({
        label: t('Cancel'),
        className: 'oryn-btn-ghost',
        onClick: () => ctx.navigate('investigations'),
      }),
    ),
  );
}

function detail(ctx, investigation) {
  const engine = ctx.engine();
  const scenes = ctx.workspace.scenes.list();
  const notes = ctx.workspace.notes
    .list()
    .filter((note) => note.investigationId === investigation.id);
  const titleInput = el('input', {
    className: 'oryn-input',
    attrs: {
      type: 'text',
      value: investigation.title,
      maxlength: 200,
      'aria-label': t('Title'),
    },
  });
  const summaryInput = el('textarea', {
    className: 'oryn-textarea',
    attrs: { rows: 3, 'aria-label': t('Summary') },
    text: investigation.summary,
  });
  const statusSelect = el('select', {
    className: 'oryn-select',
    attrs: { 'aria-label': t('Status') },
  });
  for (const status of INVESTIGATION_STATUSES) {
    const option = el('option', { attrs: { value: status }, text: status });
    if (status === investigation.status) option.selected = true;
    statusSelect.append(option);
  }
  statusSelect.addEventListener('change', () => {
    ctx.workspace.setInvestigationStatus(investigation.id, statusSelect.value);
    ctx.rerender();
  });
  const noteInput = el('textarea', {
    className: 'oryn-textarea',
    attrs: { rows: 2, placeholder: t('Add a timeline note'), maxlength: 2000 },
  });
  const sceneSelect = el('select', {
    className: 'oryn-select',
    attrs: { 'aria-label': t('Attach saved scene') },
  });
  sceneSelect.append(
    el('option', { attrs: { value: '' }, text: t('Attach a saved scene…') }),
  );
  for (const scene of scenes.filter(
    (scene) => !investigation.sceneIds.includes(scene.id),
  ))
    sceneSelect.append(
      el('option', { attrs: { value: scene.id }, text: scene.name }),
    );

  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      investigation.title,
      t('Created {created} · updated {updated} · owner {owner}', {
        created: formatTimestamp(investigation.createdAt),
        updated: formatAge(investigation.updatedAt),
        owner: investigation.owner || t('analyst'),
      }),
      [
        statusChip(investigation.status),
        button({
          label: t('Back'),
          iconName: 'chevronLeft',
          className: 'oryn-btn-sm oryn-btn-ghost',
          onClick: () => ctx.navigate('investigations'),
        }),
        button({
          label: t('Export JSON'),
          iconName: 'download',
          className: 'oryn-btn-sm',
          onClick: () => ctx.exportInvestigation(investigation.id, 'json'),
        }),
        button({
          label: t('Delete'),
          iconName: 'trash',
          className: 'oryn-btn-sm oryn-btn-danger',
          onClick: () => {
            if (
              window.confirm(
                t(
                  'Delete this investigation? Notes linked to it stay in the notes store.',
                ),
              )
            ) {
              ctx.workspace.deleteInvestigation(investigation.id);
              ctx.navigate('investigations');
            }
          },
        }),
      ],
    ),
    el(
      'div',
      { className: 'oryn-grid oryn-grid-wide' },
      el(
        'div',
        { className: 'oryn-card oryn-form' },
        el('h3', { className: 'oryn-card-title', text: t('Details') }),
        el('label', { text: t('Title') }),
        titleInput,
        el('label', { text: t('Summary') }),
        summaryInput,
        el('label', { text: t('Status') }),
        statusSelect,
        el(
          'div',
          { className: 'oryn-actions' },
          button({
            label: t('Save details'),
            iconName: 'check',
            className: 'oryn-btn-sm oryn-btn-primary',
            onClick: () => {
              const title = titleInput.value.trim();
              if (!title) return;
              ctx.workspace.updateInvestigation(investigation.id, {
                title,
                summary: summaryInput.value.trim(),
              });
              ctx.toast(t('Saved'));
              ctx.rerender();
            },
          }),
        ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el('h3', {
          className: 'oryn-card-title',
          text: t('Evidence ({count})', {
            count: investigation.entities.length,
          }),
        }),
        investigation.entities.length
          ? el(
              'ul',
              { className: 'oryn-list' },
              investigation.entities.map((entity) =>
                el(
                  'li',
                  { className: 'oryn-list-item' },
                  el('a', {
                    className: 'oryn-link',
                    attrs: { href: '#' },
                    text: entity.label || entity.id,
                    on: {
                      click: (event) => {
                        event.preventDefault();
                        ctx.inspect(entity, {
                          fly: Boolean(entity.position) && Boolean(engine),
                        });
                      },
                    },
                  }),
                  el(
                    'div',
                    { className: 'oryn-actions' },
                    chip(
                      provenanceLabel(entity.provenance),
                      entity.provenance === 'analyst'
                        ? 'warn'
                        : entity.provenance === 'model'
                          ? 'demo'
                          : 'info',
                    ),
                    button({
                      iconName: 'trash',
                      className: 'oryn-btn-ghost oryn-btn-sm oryn-btn-icon',
                      title: t('Remove from investigation'),
                      onClick: () => {
                        ctx.workspace.removeEntityFromInvestigation(
                          investigation.id,
                          entity.id,
                        );
                        ctx.rerender();
                      },
                    }),
                  ),
                  el('span', {
                    className: 'oryn-card-meta',
                    text: [
                      entity.kind,
                      entity.source,
                      entity.position
                        ? formatCoordinate(
                            entity.position.lat,
                            entity.position.lon,
                          )
                        : null,
                      entity.observedAt
                        ? t('observed {time}', {
                            time: formatTimestamp(entity.observedAt),
                          })
                        : null,
                      entity.retrievedAt
                        ? t('retrieved {time}', {
                            time: formatTimestamp(entity.retrievedAt),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }),
                ),
              ),
            )
          : emptyState(
              t('No evidence yet'),
              t(
                'Add events from the queue or selected entities from the inspector.',
              ),
              button({
                label: t('Open event queue'),
                className: 'oryn-btn-sm',
                onClick: () => {
                  ctx.setActiveInvestigation(investigation.id);
                  ctx.navigate('events');
                },
              }),
            ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el('h3', { className: 'oryn-card-title', text: t('Timeline') }),
        el(
          'ul',
          { className: 'oryn-list' },
          [...investigation.timeline].reverse().map((entry) =>
            el(
              'li',
              { className: 'oryn-list-item' },
              el('span', { text: entry.text }),
              chip(
                provenanceLabel(entry.provenance),
                entry.provenance === 'analyst' ? 'warn' : 'info',
              ),
              el('span', {
                className: 'oryn-card-meta',
                text: `${formatTimestamp(entry.at)} · ${entry.kind}`,
              }),
            ),
          ),
        ),
        el(
          'div',
          { className: 'oryn-form' },
          noteInput,
          el(
            'div',
            { className: 'oryn-actions' },
            button({
              label: t('Add note'),
              iconName: 'edit',
              className: 'oryn-btn-sm',
              onClick: () => {
                const text = noteInput.value.trim();
                if (!text) return;
                ctx.workspace.addTimelineNote(investigation.id, text);
                ctx.rerender();
              },
            }),
          ),
        ),
      ),
      el(
        'div',
        { className: 'oryn-card' },
        el('h3', { className: 'oryn-card-title', text: t('Scenes and notes') }),
        investigation.sceneIds.length
          ? el(
              'ul',
              { className: 'oryn-list' },
              investigation.sceneIds.map((sceneId) => {
                const scene = scenes.find((item) => item.id === sceneId);
                return el(
                  'li',
                  { className: 'oryn-list-item' },
                  el('span', {
                    text: scene?.name || t('(scene no longer exists)'),
                  }),
                  scene && engine
                    ? button({
                        label: t('Open'),
                        className: 'oryn-btn-sm',
                        onClick: () => ctx.openScene(scene.id),
                      })
                    : null,
                );
              }),
            )
          : el('p', {
              className: 'oryn-note',
              text: t('No saved scenes attached.'),
            }),
        el(
          'div',
          { className: 'oryn-form-row' },
          sceneSelect,
          button({
            label: t('Attach'),
            className: 'oryn-btn-sm',
            onClick: () => {
              if (!sceneSelect.value) return;
              ctx.workspace.attachScene(investigation.id, sceneSelect.value);
              ctx.rerender();
            },
          }),
          button({
            label: t('Save current view as scene'),
            iconName: 'pin',
            className: 'oryn-btn-sm',
            disabled: !engine,
            onClick: () => ctx.saveSceneForInvestigation(investigation.id),
          }),
        ),
        notes.length
          ? el(
              'ul',
              { className: 'oryn-list' },
              notes.map((note) =>
                el(
                  'li',
                  { className: 'oryn-list-item' },
                  el('span', { text: note.body }),
                  chip(provenanceLabel('analyst'), 'warn'),
                  el('span', {
                    className: 'oryn-card-meta',
                    text: `${note.author} · ${formatTimestamp(note.createdAt)}${note.target ? ` · ${note.target.label || note.target.id}` : ''}`,
                  }),
                ),
              ),
            )
          : el('p', {
              className: 'oryn-note',
              text: t('No entity notes are linked to this investigation.'),
            }),
      ),
    ),
  );
}

export function renderInvestigations(ctx, params = {}) {
  if (params.create)
    return el(
      'div',
      { className: 'oryn-page' },
      pageHead(t('Investigations')),
      createForm(ctx),
    );
  if (params.id) {
    const investigation = ctx.workspace.investigations.get(params.id);
    if (investigation) return detail(ctx, investigation);
  }
  const list = ctx.workspace.investigations
    .list()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Investigations'),
      t(
        'Collect events, entities, notes and scenes into a reviewable record. Stored locally in this browser.',
      ),
      [
        button({
          label: t('New investigation'),
          iconName: 'plus',
          className: 'oryn-btn-primary',
          onClick: () => ctx.navigate('investigations', { create: true }),
        }),
      ],
    ),
    list.length
      ? el(
          'div',
          { className: 'oryn-grid' },
          list.map((inv) =>
            el(
              'div',
              { className: 'oryn-card' },
              el(
                'div',
                { className: 'oryn-card-head' },
                el('a', {
                  className: 'oryn-card-title oryn-link',
                  attrs: { href: '#' },
                  text: inv.title,
                  on: {
                    click: (event) => {
                      event.preventDefault();
                      ctx.navigate('investigations', { id: inv.id });
                    },
                  },
                }),
                statusChip(inv.status),
              ),
              el('p', {
                className: 'oryn-card-body',
                text: inv.summary || t('No summary.'),
              }),
              el('span', {
                className: 'oryn-card-meta',
                text: t(
                  '{count} evidence items · {notes} timeline entries · updated {age}',
                  {
                    count: inv.entities.length,
                    notes: inv.timeline.length,
                    age: formatAge(inv.updatedAt),
                  },
                ),
              }),
              el(
                'div',
                { className: 'oryn-actions' },
                button({
                  label: t('Open'),
                  className: 'oryn-btn-sm',
                  onClick: () => ctx.navigate('investigations', { id: inv.id }),
                }),
                button({
                  label:
                    ctx.activeInvestigationId === inv.id
                      ? t('Active')
                      : t('Set active'),
                  className: 'oryn-btn-sm oryn-btn-ghost',
                  pressed: ctx.activeInvestigationId === inv.id,
                  onClick: () => {
                    ctx.setActiveInvestigation(inv.id);
                    ctx.rerender();
                  },
                }),
              ),
            ),
          ),
        )
      : emptyState(
          t('No investigations yet'),
          t(
            'Start one here, or add an event from the queue to create one on the spot.',
          ),
        ),
  );
}

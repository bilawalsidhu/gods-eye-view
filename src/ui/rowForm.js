/** Reconcile small layer forms without replacing focused controls or drafts. */
export function syncRowForm(container, descriptor, bind) {
  if (!container) return;
  container.hidden = !descriptor;
  if (!descriptor) return;
  container._descriptor = descriptor;
  const doc = container.ownerDocument;
  const reset = container._revision !== descriptor.revision;
  container._revision = descriptor.revision;
  if (!container._fields) {
    container._fields = new Map();
    container._actions = new Map();
    container.setAttribute('role', 'group');
  }
  container.setAttribute('aria-label', descriptor.label || 'Layer filters');
  const values = () =>
    Object.fromEntries(
      [...container._fields].map(([id, { control }]) => [id, control.value]),
    );
  const invoke = (id) => {
    const action = container._descriptor?.actions?.find(
      (entry) => entry.id === id,
    );
    if (!container.hidden && action && !action.disabled) {
      Promise.resolve(action.onClick?.(values())).catch(() => {});
    }
  };
  const wanted = new Set((descriptor.fields || []).map((field) => field.id));
  for (const [id, entry] of container._fields) {
    if (!wanted.has(id)) {
      entry.label.remove();
      container._fields.delete(id);
    }
  }
  for (const field of descriptor.fields || []) {
    let entry = container._fields.get(field.id);
    if (!entry) {
      const label = doc.createElement('label');
      label.className = 'data-row-field';
      const text = doc.createElement('span');
      const control = doc.createElement(field.options ? 'select' : 'input');
      if (!field.options) {
        control.type = 'text';
        control.autocomplete = 'off';
        control.spellcheck = false;
        bind(control, 'keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.stopPropagation();
          invoke('apply');
        });
      }
      control.dataset.fieldId = field.id;
      label.append(text, control);
      container.appendChild(label);
      entry = { label, text, control };
      container._fields.set(field.id, entry);
    }
    const { text, control } = entry;
    if (text.textContent !== field.label) text.textContent = field.label;
    control.setAttribute('aria-label', field.label);
    if (field.options) {
      if (entry.options !== field.options) {
        const selected = control.value;
        for (const child of [...control.children]) child.remove();
        for (const option of field.options) {
          const node = doc.createElement('option');
          node.value = option.value;
          node.textContent = option.label;
          control.appendChild(node);
        }
        control.value = field.options.some(
          (option) => option.value === selected,
        )
          ? selected
          : field.value || '';
        entry.options = field.options;
      }
    } else {
      control.placeholder = field.placeholder || '';
      control.maxLength = field.maxLength || 64;
    }
    if (reset) control.value = field.value || '';
    control.disabled = Boolean(field.disabled);
  }
  const actionIds = new Set(
    (descriptor.actions || []).map((action) => action.id),
  );
  for (const [id, button] of container._actions) {
    if (!actionIds.has(id)) {
      button.remove();
      container._actions.delete(id);
    }
  }
  for (const action of descriptor.actions || []) {
    let button = container._actions.get(action.id);
    if (!button) {
      button = doc.createElement('button');
      button.type = 'button';
      button.className = 'data-row-form-action';
      bind(button, 'click', () => invoke(action.id));
      container.appendChild(button);
      container._actions.set(action.id, button);
    }
    if (button.textContent !== action.label) button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
  }
}

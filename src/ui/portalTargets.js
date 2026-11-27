/** Instance-owned destinations for controls that can move between panels. */
export function createPortalTargets({
  read = () => {},
  changed = () => {},
  afterMove = queueMicrotask,
} = {}) {
  const offers = new Map();
  const withdrawn = new Map();
  let order = 0;

  function offer(name, element, { shown = () => true, fallback } = {}) {
    const token = { name, element, shown, fallback, order: ++order };
    offers.set(name, [...(offers.get(name) ?? []), token]);
    changed();
    return token;
  }

  function withdraw(token) {
    const name = token?.name;
    const stack = offers.get(name);
    if (!stack?.includes(token)) return;
    const remaining = stack.filter((entry) => entry !== token);
    if (remaining.length) offers.set(name, remaining);
    else offers.delete(name);

    const older = withdrawn.get(name);
    const active = token.element.ownerDocument.activeElement;
    const record = {
      token: older?.token.order > token.order ? older.token : token,
      focus: token.element.contains(active) ? active : (older?.focus ?? null),
    };
    withdrawn.set(name, record);
    changed();
    afterMove(() => {
      if (withdrawn.get(name) === record) withdrawn.delete(name);
    });
  }

  function target(name) {
    read();
    return (
      offers.get(name)?.findLast((entry) => entry.shown())?.element ?? null
    );
  }

  function takeDropped(name) {
    const record = withdrawn.get(name);
    const focus = record?.focus ?? null;
    if (record) record.focus = null;
    return focus;
  }

  function fallbackOf(name) {
    const current = offers.get(name)?.at(-1);
    const prior = withdrawn.get(name)?.token;
    const latest =
      prior && (!current || prior.order > current.order) ? prior : current;
    return latest?.fallback?.() ?? null;
  }

  return { offer, withdraw, target, takeDropped, fallbackOf };
}

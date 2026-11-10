/** The five public drawing registries, with no SDK objects or volatile fields. */
export function drawLedger(page) {
  return page.evaluate(() => {
    const { engine, dataManager } = window.__godsEyeView;
    const owners = [...(dataManager?.layers.keys() ?? [])].sort(
      (a, b) => b.length - a.length,
    );
    const ownerOf = (id) =>
      owners.find((owner) => id === owner || id.startsWith(owner + '-')) ??
      (id.startsWith('wind-field-') ? 'wind' : undefined) ??
      (id.startsWith('bhote-koshi-imagery-') ||
      id.startsWith('bhote-koshi-flood-')
        ? 'bhote-koshi-2026'
        : undefined);
    return ['movers', 'lines', 'ground', 'imagery', 'meshes']
      .flatMap((family) =>
        engine[family].list().map((row) => ({
          id: String(row.id),
          family,
          ...(ownerOf(String(row.id))
            ? { layer: ownerOf(String(row.id)) }
            : {}),
          ...(row.kind === undefined ? {} : { kind: row.kind }),
          ...(row.count === undefined ? {} : { count: row.count }),
          shown: row.shown ?? true,
        })),
      )
      .sort(
        (a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id),
      );
  });
}

/** Allowlisted absences keep their reasons; visibility differences are never hidden. */
export function compareLedgers(before, after, allow = []) {
  const key = (row) => `${row.family}:${row.id}`;
  const left = new Map(before.map((row) => [key(row), row]));
  const right = new Map(after.map((row) => [key(row), row]));
  const allowed = [];
  const only = (a, b, side) =>
    [...a].flatMap(([key, row]) => {
      if (b.has(key)) return [];
      const exception = allow.find(
        (entry) =>
          !entry.field &&
          entry.id === row.id &&
          (!entry.family || entry.family === row.family),
      );
      if (exception) {
        allowed.push({
          id: row.id,
          family: row.family,
          side,
          reason: exception.reason,
        });
        return [];
      }
      return [{ id: row.id, family: row.family }];
    });
  return {
    onlyBefore: only(left, right, 'before'),
    onlyAfter: only(right, left, 'after'),
    shown: [...left].flatMap(([key, row]) => {
      const next = right.get(key);
      return next && (row.shown ?? true) !== (next.shown ?? true)
        ? [
            {
              id: row.id,
              family: row.family,
              before: row.shown ?? true,
              after: next.shown ?? true,
            },
          ]
        : [];
    }),
    allowed,
  };
}

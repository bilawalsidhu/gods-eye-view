/** Record import writes at the globe contract, including per-instance styles. */
export async function installImportProbe(page) {
  await page.evaluate(() => {
    const engine = window.__godsEyeView.engine;
    const records = new Map();
    for (const [kind, method] of [
      ['movers', 'createSet'],
      ['ground', 'createSet'],
      ['lines', 'createLine'],
      ['imagery', 'createLayer'],
    ]) {
      const create = engine[kind][method].bind(engine[kind]);
      engine[kind][method] = (options) => {
        const handle = create(options);
        if (!options.id.startsWith('geo-import-')) return handle;
        const record = { kind, options, handle, items: [], positions: [] };
        records.set(options.id, record);
        const wrap = (name, after) => {
          const original = handle[name].bind(handle);
          handle[name] = (...args) => {
            const result = original(...args);
            after(...args);
            return result;
          };
        };
        if (kind === 'movers')
          wrap('set', (index, fields) => {
            record.items[index] = { ...record.items[index], ...fields };
          });
        if (kind === 'ground')
          wrap('replace', (items) => {
            record.items = items;
          });
        if (kind === 'lines')
          wrap('setPositions', (positions) => {
            record.positions = positions;
          });
        wrap('destroy', () => records.delete(options.id));
        return handle;
      };
    }
    window.__qaImports = {
      list: () =>
        Object.fromEntries(
          ['movers', 'ground', 'lines', 'imagery'].map((kind) => [
            kind,
            engine[kind]
              .list()
              .filter(({ id }) => id.startsWith('geo-import-')),
          ]),
        ),
      records: () => [...records.values()],
      groups: () => {
        const groups = new Map();
        for (const record of records.values()) {
          const id = record.options.id.match(/^geo-import-\d+/)[0];
          if (!groups.has(id)) groups.set(id, []);
          groups.get(id).push(record);
        }
        return [...groups.values()];
      },
    };
  });
}

/** Catch invalid source graphs before a cached fallback can wait on itself. */
export function indexMapSources(sources) {
  const index = new Map();
  for (const source of sources) {
    const id = source?.descriptor?.id;
    if (typeof id !== 'string' || !id || index.has(id))
      throw new TypeError('Map source IDs must be nonempty and unique');
    index.set(id, source);
  }
  for (const id of index.keys()) {
    const seen = new Set();
    let next = id;
    while (next) {
      if (seen.has(next)) throw new TypeError('Map source fallback cycle');
      if (!index.has(next)) throw new TypeError('Unknown map fallback source');
      seen.add(next);
      next = index.get(next).constructionFallback?.id;
    }
  }
  return index;
}

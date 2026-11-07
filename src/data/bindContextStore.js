/** Resolve a retained layer's context calls against its current attachment. */
export function bindContextStore(context, getEngine) {
  if (!context?.forEngine) return context;
  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => [
        name,
        (...args) => context.forEngine(getEngine())?.[name]?.(...args),
      ]),
  );
}

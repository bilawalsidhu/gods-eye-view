/** Bind a source contract once for the application without replacing its layer instance. */
export function createSourceSlot(
  initial,
  methods,
  label = 'Source',
  optional = {},
) {
  let active = initial;
  let binding = Symbol(label);
  const source = Object.fromEntries(
    [...methods, ...Object.keys(optional)].map((method) => [
      method,
      (...args) => {
        if (typeof active?.[method] !== 'function' && optional[method])
          return optional[method](...args);
        if (typeof active?.[method] !== 'function')
          throw new Error(`${label} is not configured`);
        const owner = binding;
        const provider = active;
        const value = provider[method](...args);
        if (value && typeof value.then === 'function') {
          const requireCurrentOwner = () => {
            if (binding !== owner || active !== provider)
              throw new DOMException(`${label} was replaced`, 'AbortError');
          };
          return value.then(
            (result) => {
              requireCurrentOwner();
              return result;
            },
            (error) => {
              requireCurrentOwner();
              throw error;
            },
          );
        }
        return value;
      },
    ]),
  );
  for (const property of ['label', 'attribution']) {
    Object.defineProperty(source, property, {
      enumerable: true,
      get: () => active?.[property],
    });
  }
  return {
    source,
    get binding() {
      return binding;
    },
    configure(next) {
      if (methods.some((method) => typeof next?.[method] !== 'function'))
        throw new TypeError(`Invalid ${label.toLowerCase()}`);
      const owner = Symbol(label);
      active = next;
      binding = owner;
      return () => {
        if (binding !== owner) return;
        active = null;
        binding = null;
      };
    },
  };
}

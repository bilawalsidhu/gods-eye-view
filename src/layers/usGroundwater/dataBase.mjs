/** Explicit, credential-free data origin; every artifact stays below its base. */
export function createWellDataUrlResolver(
  base = '/well-index-v1/',
  allowedDataOrigins = [],
  appOrigin = globalThis.location?.origin ?? 'https://gev.invalid',
) {
  const refuse = () => {
    throw new TypeError('Invalid well data base or origin');
  };
  if (!Array.isArray(allowedDataOrigins) || allowedDataOrigins.length > 8)
    refuse();
  const allowed = new Set();
  for (const value of allowedDataOrigins) {
    if (typeof value !== 'string' || value.length > 256) refuse();
    let url;
    try {
      url = new URL(value);
    } catch {
      refuse();
    }
    if (url.protocol !== 'https:' || url.origin !== value) refuse();
    allowed.add(value);
  }
  let origin;
  try {
    origin = new URL(appOrigin);
  } catch {
    refuse();
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== appOrigin
  )
    refuse();
  if (typeof base !== 'string' || base.length > 2048) refuse();
  let root;
  try {
    root = new URL(base, origin);
  } catch {
    refuse();
  }
  // Canonical paths only: no queries, encoded separators, dot segments or credentials.
  const path = /^\/(?:[A-Za-z0-9_-]+\/){1,16}$/;
  if (!path.test(root.pathname) || root.pathname.length > 1024) refuse();
  if (base.startsWith('/')) {
    if (base !== root.pathname || root.origin !== origin.origin) refuse();
  } else if (
    base !== root.origin + root.pathname ||
    root.protocol !== 'https:' ||
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    !allowed.has(root.origin)
  )
    refuse();
  return (relative) => {
    if (
      typeof relative !== 'string' ||
      relative.length > 2048 ||
      !/^(?:[A-Za-z0-9_-]+\/){0,16}[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$/.test(
        relative,
      )
    )
      throw new TypeError('Invalid well artifact path');
    const url = new URL(relative, root);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname))
      throw new TypeError('Well artifact outside data base');
    return url.href;
  };
}

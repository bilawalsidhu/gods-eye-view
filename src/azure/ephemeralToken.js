function expiryMilliseconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize the short-lived token shapes used by traffic and Foundry BFFs.
 */
export function normalizeEphemeralToken(data, now = Date.now()) {
  const raw = data?.token
    ?? data?.access_token
    ?? data?.value
    ?? data?.clientSecret?.value
    ?? data?.client_secret?.value
    ?? data?.client_secret;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new TypeError('Token response did not include an ephemeral token');

  const expiresAt = expiryMilliseconds(
    data?.expiresAt
      ?? data?.expires_at
      ?? data?.clientSecret?.expiresAt
      ?? data?.client_secret?.expires_at,
  ) ?? (Number.isFinite(Number(data?.expiresIn ?? data?.expires_in))
    ? now + Number(data.expiresIn ?? data.expires_in) * 1000
    : now + 5 * 60_000);

  return Object.freeze({ value, expiresAt });
}

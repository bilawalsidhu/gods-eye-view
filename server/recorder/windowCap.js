/**
 * Paging for /window. Rows come back ordered by (layer, id, ts), the table's
 * unique key, so a page can resume exactly after its last row. The cursor is an
 * opaque token: callers hand it back unchanged and never read inside it.
 */

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.layer, row.id, row.ts])).toString(
    'base64url',
  );
}

/** The key a cursor stands for, or null when it is not one we issued. */
export function decodeCursor(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  try {
    const [layer, id, ts] = JSON.parse(
      Buffer.from(token, 'base64url').toString('utf8'),
    );
    if (typeof layer !== 'string' || typeof id !== 'string') return null;
    if (!Number.isFinite(ts)) return null;
    return { layer, id, ts };
  } catch {
    return null;
  }
}

/**
 * Caps one page. The caller asks the store for `limit + 1` rows; the extra row
 * proves there was more, so a page of exactly `limit` rows is not called cut.
 * `nextCursor` is set only when there is more to fetch.
 */
export function capWindow(rows, limit) {
  const truncated = rows.length > limit;
  const points = truncated ? rows.slice(0, limit) : rows;
  return {
    points,
    truncated,
    nextCursor: truncated ? encodeCursor(points[points.length - 1]) : null,
  };
}

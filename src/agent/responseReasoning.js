/** Opaque Responses continuation data. Never render or persist it in the UI. */
export function normalizeResponseReasoning(items) {
  if (!Array.isArray(items) || items.length > 16) return [];
  let bytes = 0;
  const result = [];
  for (const item of items) {
    if (
      item?.type !== 'reasoning' ||
      typeof item.id !== 'string' ||
      item.id.length > 256 ||
      typeof item.encrypted_content !== 'string' ||
      !item.encrypted_content
    )
      return [];
    bytes += item.encrypted_content.length;
    if (bytes > 128 * 1024) return [];
    result.push({
      type: 'reasoning',
      id: item.id,
      encrypted_content: item.encrypted_content,
      summary: [],
    });
  }
  return result;
}

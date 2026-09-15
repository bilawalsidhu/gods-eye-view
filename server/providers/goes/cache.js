/** Create a bounded least-recently-used frame cache. */
export function createFrameCache({
  maxFrames = 8,
  maxBytes = 64 * 1024 * 1024,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  function trim() {
    while (entries.size > maxFrames || bytes > maxBytes) {
      const [id, entry] = entries.entries().next().value;
      entries.delete(id);
      bytes -= entry.bytes;
    }
  }
  return {
    put(frameId, parts) {
      if (entries.has(frameId)) bytes -= entries.get(frameId).bytes;
      const entry = {
        parts,
        bytes: parts.reduce((sum, part) => sum + part.png.length, 0),
      };
      entries.set(frameId, entry);
      bytes += entry.bytes;
      trim();
    },
    get(frameId) {
      const entry = entries.get(frameId);
      if (!entry) return undefined;
      entries.delete(frameId);
      entries.set(frameId, entry);
      return entry.parts;
    },
    has(frameId) {
      return entries.has(frameId);
    },
    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}

/**
 * In-memory LRU of frame PNGs, bounded by entry count and total bytes. Nothing
 * here touches disk: the imagery is held only while the operator's own server
 * runs, as the Bureau of Meteorology's FTP terms require.
 */
export function createFrameCache({
  maxFrames = 96,
  maxBytes = 48 * 1024 * 1024,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  return {
    get(file) {
      const buffer = entries.get(file);
      if (!buffer) return undefined;
      // Re-insert so the Map's iteration order stays least-recently-used first.
      entries.delete(file);
      entries.set(file, buffer);
      return buffer;
    },
    set(file, buffer) {
      // A single frame larger than the budget would only evict everything else.
      if (buffer.length > maxBytes) return false;
      const previous = entries.get(file);
      if (previous) bytes -= previous.length;
      entries.delete(file);
      entries.set(file, buffer);
      bytes += buffer.length;
      while (entries.size > maxFrames || bytes > maxBytes) {
        const [oldest, evicted] = entries.entries().next().value;
        entries.delete(oldest);
        bytes -= evicted.length;
      }
      return true;
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    stats: () => ({ frames: entries.size, bytes }),
  };
}

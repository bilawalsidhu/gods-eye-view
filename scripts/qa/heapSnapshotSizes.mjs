// The live heap by V8 node type, read from a heap snapshot as it streams in:
// only the nodes array is parsed, number by number, so a snapshot of a large
// page is never held whole. The long soak asserts on the heap without the
// `code` nodes (compiled code grows with V8's tier-ups over a long run, and
// the browser drops it under memory pressure).

/**
 * A parser fed with a heap snapshot's JSON text in chunks. `result()` gives
 * the self size summed per node type name.
 */
export function createHeapSnapshotSizes() {
  let head = '';
  let fields = null;
  let typeOffset = -1;
  let sizeOffset = -1;
  let typeNames = null;
  let inNodes = false;
  let done = false;
  let number = '';
  let field = 0;
  let type = 0;
  const sizes = new Map();

  function take(value) {
    if (field === typeOffset) type = value;
    if (field === sizeOffset) {
      const name = typeNames[type] ?? String(type);
      sizes.set(name, (sizes.get(name) ?? 0) + value);
    }
    field = (field + 1) % fields.length;
  }

  function nodes(text, from) {
    for (let i = from; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) number += text[i];
      else {
        if (number) {
          take(Number(number));
          number = '';
        }
        if (c === 93) {
          done = true;
          return;
        }
      }
    }
  }

  return {
    push(chunk) {
      if (done) return;
      if (inNodes) {
        nodes(chunk, 0);
        return;
      }
      head += chunk;
      const start = head.indexOf('"nodes":[');
      if (start < 0) return;
      const meta = JSON.parse(
        head.slice(head.indexOf('"meta":') + 7, head.indexOf(',"node_count"')),
      );
      fields = meta.node_fields;
      typeOffset = fields.indexOf('type');
      sizeOffset = fields.indexOf('self_size');
      [typeNames] = meta.node_types;
      inNodes = true;
      const rest = head.slice(start + '"nodes":['.length);
      head = '';
      nodes(rest, 0);
    },
    result() {
      return Object.fromEntries(sizes);
    },
  };
}

/** Take a heap snapshot over a CDP session and size it by node type. */
export async function heapSizesByType(cdp) {
  const sizes = createHeapSnapshotSizes();
  const onChunk = ({ chunk }) => sizes.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      captureNumericValue: false,
    });
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    // A snapshot leaves the profiler tracking object ids, which slows the
    // page for the rest of the run (Navara → Cesium switches about 2.5 times
    // slower in the long soak); it stops here.
    await cdp.send('HeapProfiler.disable').catch(() => {});
  }
  return sizes.result();
}

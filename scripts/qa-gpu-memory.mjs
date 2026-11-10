/** Install before startup. Counts WebGL allocations minus explicit deletions;
 * implicit garbage collection and driver/Metal caches are not observed. */
export function installGpuMemoryProbe() {
  const handles = new WeakMap(),
    contexts = new WeakMap(),
    allocations = new Map();
  let sequence = 0;
  const id = (handle) => {
    if (!handle) return null;
    if (!handles.has(handle)) handles.set(handle, ++sequence);
    return handles.get(handle);
  };
  const state = (gl) => {
    if (!contexts.has(gl))
      contexts.set(gl, {
        unit: 0,
        textures: new Map(),
        buffers: new Map(),
        renderbuffer: null,
      });
    return contexts.get(gl);
  };
  const bytesPerPixel = (format, type) => {
    const sized = {
      33321: 1,
      33323: 2,
      32849: 3,
      32856: 4,
      35907: 4,
      33325: 2,
      33327: 4,
      34843: 6,
      34842: 8,
      33326: 4,
      33328: 8,
      34837: 12,
      34836: 16,
      33189: 2,
      33190: 4,
      36012: 4,
      35056: 4,
      36013: 8,
      36168: 1,
      32854: 2,
      32855: 2,
      36194: 2,
      35898: 4,
    };
    if (sized[format]) return sized[format];
    if ([33635, 32819, 32820].includes(type)) return 2;
    if ([34042, 33640, 35899].includes(type)) return 4;
    const channels =
      {
        6403: 1,
        6406: 1,
        6409: 1,
        33319: 2,
        6410: 2,
        6407: 3,
        6408: 4,
        6402: 1,
      }[format] || 4;
    return (
      channels *
      ({
        5121: 1,
        5120: 1,
        5122: 2,
        5123: 2,
        5131: 2,
        36193: 2,
        5124: 4,
        5125: 4,
        5126: 4,
      }[type] || 1)
    );
  };
  const textureTarget = (target) =>
    target >= 34069 && target <= 34074 ? 34067 : target;
  const recordTexture = (
    gl,
    target,
    level,
    format,
    width,
    height,
    depth = 1,
    type,
    bytes,
  ) => {
    const key = state(gl).textures.get(
      `${state(gl).unit}:${textureTarget(target)}`,
    );
    if (key == null) return;
    let entry = allocations.get(key);
    if (!entry)
      allocations.set(key, (entry = { kind: 'texture', levels: new Map() }));
    entry.levels.set(`${target}:${level}`, {
      target,
      level,
      width,
      height,
      depth,
      format,
      type,
      bytes: bytes ?? width * height * depth * bytesPerPixel(format, type),
    });
  };
  const wrap = (proto, name, after) => {
    const original = proto?.[name];
    if (typeof original !== 'function') return;
    proto[name] = function (...args) {
      const result = original.apply(this, args);
      after(this, args, result);
      return result;
    };
  };
  for (const proto of [
    globalThis.WebGLRenderingContext?.prototype,
    globalThis.WebGL2RenderingContext?.prototype,
  ]) {
    wrap(proto, 'activeTexture', (gl, [unit]) => {
      state(gl).unit = unit;
    });
    wrap(proto, 'bindTexture', (gl, [target, handle]) =>
      state(gl).textures.set(`${state(gl).unit}:${target}`, id(handle)),
    );
    wrap(proto, 'deleteTexture', (_gl, [handle]) =>
      allocations.delete(handles.get(handle)),
    );
    wrap(proto, 'texImage2D', (gl, a) => {
      if (a.length >= 9)
        recordTexture(gl, a[0], a[1], a[2], a[3], a[4], 1, a[7]);
      else {
        const s = a[5];
        recordTexture(
          gl,
          a[0],
          a[1],
          a[2],
          s?.videoWidth || s?.width || 0,
          s?.videoHeight || s?.height || 0,
          1,
          a[4],
        );
      }
    });
    wrap(proto, 'texImage3D', (gl, a) =>
      recordTexture(gl, a[0], a[1], a[2], a[3], a[4], a[5], a[8]),
    );
    for (const dimensions of [2, 3])
      wrap(proto, `texStorage${dimensions}D`, (gl, a) => {
        for (let level = 0; level < a[1]; level++) {
          const faces =
            a[0] === 34067
              ? [34069, 34070, 34071, 34072, 34073, 34074]
              : [a[0]];
          for (const face of faces)
            recordTexture(
              gl,
              face,
              level,
              a[2],
              Math.max(1, a[3] >> level),
              Math.max(1, a[4] >> level),
              dimensions === 3
                ? a[0] === 35866
                  ? a[5]
                  : Math.max(1, a[5] >> level)
                : 1,
            );
        }
      });
    wrap(proto, 'compressedTexImage2D', (gl, a) =>
      recordTexture(
        gl,
        a[0],
        a[1],
        a[2],
        a[3],
        a[4],
        1,
        null,
        typeof a[6] === 'number' ? a[6] : a[6]?.byteLength || 0,
      ),
    );
    wrap(proto, 'generateMipmap', (gl, [target]) => {
      const entry = allocations.get(
        state(gl).textures.get(`${state(gl).unit}:${target}`),
      );
      for (const base of [...(entry?.levels.values() || [])].filter(
        (x) => x.level === 0,
      )) {
        for (let level = 1; Math.max(base.width, base.height) >> level; level++)
          recordTexture(
            gl,
            base.target,
            level,
            base.format,
            Math.max(1, base.width >> level),
            Math.max(1, base.height >> level),
            base.depth,
            base.type,
            Math.max(1, base.bytes / 4 ** level),
          );
      }
    });
    wrap(proto, 'bindRenderbuffer', (gl, [_target, handle]) => {
      state(gl).renderbuffer = id(handle);
    });
    wrap(proto, 'deleteRenderbuffer', (_gl, [handle]) =>
      allocations.delete(handles.get(handle)),
    );
    wrap(proto, 'renderbufferStorage', (gl, a) =>
      allocations.set(state(gl).renderbuffer, {
        kind: 'renderbuffer',
        bytes: a[2] * a[3] * bytesPerPixel(a[1]),
      }),
    );
    wrap(proto, 'renderbufferStorageMultisample', (gl, a) =>
      allocations.set(state(gl).renderbuffer, {
        kind: 'renderbuffer',
        bytes: Math.max(1, a[1]) * a[3] * a[4] * bytesPerPixel(a[2]),
      }),
    );
    wrap(proto, 'bindBuffer', (gl, [target, handle]) =>
      state(gl).buffers.set(target, id(handle)),
    );
    wrap(proto, 'deleteBuffer', (_gl, [handle]) =>
      allocations.delete(handles.get(handle)),
    );
    wrap(
      proto,
      'bufferData',
      (gl, [target, data, _usage, offset = 0, length]) =>
        allocations.set(state(gl).buffers.get(target), {
          kind: 'buffer',
          bytes:
            typeof data === 'number'
              ? data
              : (length ??
                    (data?.length != null ? data.length - offset : null)) !=
                  null
                ? (length ?? data.length - offset) *
                  (data.BYTES_PER_ELEMENT || 1)
                : data?.byteLength || 0,
        }),
    );
  }
  globalThis.__gevGpuMemory = () => {
    const result = {
      textureBytes: 0,
      renderbufferBytes: 0,
      bufferBytes: 0,
      textureCount: 0,
      renderbufferCount: 0,
      bufferCount: 0,
    };
    for (const entry of allocations.values()) {
      result[`${entry.kind}Count`]++;
      result[`${entry.kind}Bytes`] += entry.levels
        ? [...entry.levels.values()].reduce(
            (sum, level) => sum + level.bytes,
            0,
          )
        : entry.bytes;
    }
    result.totalBytes =
      result.textureBytes + result.renderbufferBytes + result.bufferBytes;
    return result;
  };
}

const CELL = 512,
  ATLAS = CELL * 4,
  STRIDE = 8;
const VERTEX = `#version 300 es
in vec2 pixel; in vec2 uv; in vec4 tint;
uniform vec2 viewport;
out vec2 texCoord; out vec4 color;
void main(){ gl_Position=vec4(pixel.x/viewport.x*2.0-1.0,1.0-pixel.y/viewport.y*2.0,0,1); texCoord=uv; color=tint; }`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D atlas;
in vec2 texCoord; in vec4 color; out vec4 result;
void main(){ vec4 sampleColor=texture(atlas,texCoord); float alpha=sampleColor.a*color.a; result=vec4(sampleColor.rgb*color.rgb*alpha,alpha); }`;

/** One bounded atlas and one indexed draw, independent of contact population. */
export class AircraftSurfaceGpu {
  constructor(canvas, paint) {
    this.canvas = canvas;
    this.paint = paint;
    this.slots = new Map();
    const gl = (this.gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    }));
    if (!gl) throw new Error('Aircraft surface WebGL2 unavailable');
    const shader = (type, source) => {
      const item = gl.createShader(type);
      gl.shaderSource(item, source);
      gl.compileShader(item);
      if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(item);
        gl.deleteShader(item);
        throw new Error(error);
      }
      return item;
    };
    this.program = gl.createProgram();
    const vs = shader(gl.VERTEX_SHADER, VERTEX),
      fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(this.program));
    gl.useProgram(this.program);
    this.viewport = gl.getUniformLocation(this.program, 'viewport');
    this.vertices = gl.createBuffer();
    this.indices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
    for (const [name, n, offset] of [
      ['pixel', 2, 0],
      ['uv', 2, 2],
      ['tint', 4, 4],
    ]) {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        n,
        gl.FLOAT,
        false,
        STRIDE * 4,
        offset * 4,
      );
    }
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      ATLAS,
      ATLAS,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.tile = document.createElement('canvas');
    this.tile.width = this.tile.height = CELL;
    this.ctx = this.tile.getContext('2d');
    if (!this.ctx || gl.getError() !== gl.NO_ERROR)
      throw new Error('Aircraft surface allocation failed');
    this.capacity = 0;
    this.count = 0;
  }
  grow(required) {
    if (required <= this.capacity) return;
    this.capacity = Math.max(256, 2 ** Math.ceil(Math.log2(required)));
    this.data = new Float32Array(this.capacity * 4 * STRIDE);
    const indices = new Uint32Array(this.capacity * 6);
    for (let i = 0; i < this.capacity; i++)
      indices.set(
        [i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3],
        i * 6,
      );
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  }
  slot(kind) {
    let slot = this.slots.get(kind);
    if (slot) return slot;
    if (this.slots.size >= 16)
      throw new Error('Aircraft atlas capacity exceeded');
    const index = this.slots.size,
      x = (index % 4) * CELL,
      y = Math.floor(index / 4) * CELL;
    const ctx = this.ctx;
    ctx.resetTransform();
    ctx.clearRect(0, 0, CELL, CELL);
    ctx.setTransform(CELL / 96, 0, 0, CELL / 96, CELL / 2, CELL / 2);
    this.paint(kind, ctx);
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.tile,
    );
    slot = {
      left: x / ATLAS,
      right: (x + CELL) / ATLAS,
      top: (y + CELL) / ATLAS,
      bottom: y / ATLAS,
    };
    this.slots.set(kind, slot);
    return slot;
  }
  begin(width, height, pw, ph, capacity) {
    this.grow(capacity);
    this.count = 0;
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    const gl = this.gl;
    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.viewport, width, height);
  }
  add(b, kind, x, y, w, h) {
    const slot = this.slot(kind),
      cos = Math.cos(-b.rotation),
      sin = Math.sin(-b.rotation),
      color = b.color,
      data = this.data;
    let index = this.count * 4 * STRIDE;
    for (let vertex = 0; vertex < 4; vertex++) {
      const right = vertex === 1 || vertex === 2,
        bottom = vertex >= 2;
      const dx = (right ? 0.5 : -0.5) * w,
        dy = (bottom ? 0.5 : -0.5) * h;
      data[index++] = x + cos * dx - sin * dy;
      data[index++] = y + sin * dx + cos * dy;
      data[index++] = right ? slot.right : slot.left;
      data[index++] = bottom ? slot.bottom : slot.top;
      data[index++] = color.red;
      data[index++] = color.green;
      data[index++] = color.blue;
      data[index++] = color.alpha;
    }
    this.count++;
  }
  flush() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * 4 * STRIDE);
    gl.drawElements(gl.TRIANGLES, this.count * 6, gl.UNSIGNED_INT, 0);
    gl.flush();
  }
  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.vertices);
    gl.deleteBuffer(this.indices);
    gl.deleteProgram(this.program);
    this.tile.width = this.tile.height = 1;
    this.slots.clear();
    this.canvas.width = this.canvas.height = 1;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  get bytes() {
    return (
      ATLAS * ATLAS * 4 +
      CELL * CELL * 4 +
      2 * (this.data?.byteLength || 0) +
      this.capacity * 6 * 4
    );
  }
}

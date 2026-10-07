import { cameraBasis, longitudeEast, pickPlanetPoint } from './planetModel.js';
const VERTEX = `attribute vec2 position; varying vec2 uv; void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
const FRAGMENT = `precision highp float; varying vec2 uv; uniform sampler2D surface;uniform vec2 viewport;uniform float zoom;uniform mat3 basis;const float PI=3.141592653589793;void main(){vec2 p=(uv*2.-1.)*vec2(viewport.x/viewport.y,1.)/zoom;float r2=dot(p,p);if(r2>1.){gl_FragColor=vec4(.025,.05,.06,1.);return;}vec3 n=vec3(p,sqrt(1.-r2));vec3 body=basis*n;vec2 st=vec2(fract(atan(body.x,body.z)/(2.*PI)+.5),asin(clamp(body.y,-1.,1.))/PI+.5);vec3 color=texture2D(surface,st).rgb;float shade=.8+.2*max(0.,dot(n,normalize(vec3(-.4,.6,1.))));gl_FragColor=vec4(color*shade,1.);}`;
/** Lightweight spherical overview: static pixels, illustrative lighting, no DEM or Earth SDK. */
export async function createPlanetRenderer({
  canvas,
  textureUrl,
  center = { lat: 0, lon: 0 },
  onChange = () => {},
  onPick = () => {},
}) {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL unavailable.');
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX),
    fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT),
    program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error('Planet shader link failed.');
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const image = new Image();
  image.src = textureUrl;
  await image.decode();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const locations = {
    viewport: gl.getUniformLocation(program, 'viewport'),
    zoom: gl.getUniformLocation(program, 'zoom'),
    basis: gl.getUniformLocation(program, 'basis'),
  };
  let zoom = 0.85,
    disposed = false,
    drag = null,
    current = { ...center };
  function draw() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect(),
      ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const basis = cameraBasis(current);
    gl.uniform2f(locations.viewport, canvas.width, canvas.height);
    gl.uniform1f(locations.zoom, zoom);
    gl.uniformMatrix3fv(
      locations.basis,
      false,
      new Float32Array([...basis.right, ...basis.up, ...basis.forward]),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    onChange({ ...current }, zoom);
  }
  const down = (event) => {
    if (event.button !== 0) return;
    drag = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    };
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event) => {
    if (!drag) return;
    current = {
      lat: Math.max(
        -89,
        Math.min(89, current.lat + (event.clientY - drag.y) * 0.25),
      ),
      lon: longitudeEast(current.lon - (event.clientX - drag.x) * 0.25),
    };
    drag.x = event.clientX;
    drag.y = event.clientY;
    draw();
  };
  const up = (event) => {
    if (!drag) return;
    const click =
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4;
    drag = null;
    if (click) {
      const rect = canvas.getBoundingClientRect();
      const point = pickPlanetPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        current,
        { width: rect.width, height: rect.height, zoom },
      );
      if (point) onPick(point);
    }
  };
  const wheel = (event) => {
    event.preventDefault();
    zoom = Math.max(0.5, Math.min(4, zoom * Math.exp(-event.deltaY * 0.001)));
    draw();
  };
  const key = (event) => {
    const actions = {
      ArrowLeft: [0, -5],
      ArrowRight: [0, 5],
      ArrowUp: [5, 0],
      ArrowDown: [-5, 0],
    };
    if (actions[event.key]) {
      event.preventDefault();
      current = {
        lat: Math.max(-89, Math.min(89, current.lat + actions[event.key][0])),
        lon: longitudeEast(current.lon + actions[event.key][1]),
      };
      draw();
    } else if (['+', '-', '='].includes(event.key)) {
      event.preventDefault();
      zoom = Math.max(0.5, Math.min(4, zoom * (event.key === '-' ? 0.9 : 1.1)));
      draw();
    }
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('keydown', key);
  window.addEventListener('resize', draw);
  draw();
  return {
    focus(point) {
      current = {
        lat: Math.max(-89, Math.min(89, point.lat)),
        lon: longitudeEast(point.lon),
      };
      zoom = 1.6;
      draw();
    },
    overview() {
      current = { lat: 0, lon: 0 };
      zoom = 0.85;
      draw();
    },
    getView: () => ({ ...current, zoom }),
    destroy() {
      disposed = true;
      gl.clearColor(0.025, 0.05, 0.06, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('keydown', key);
      window.removeEventListener('resize', draw);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    },
  };
}

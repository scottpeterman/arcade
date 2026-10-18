// banrion/js/glrender.js
//
// Banrion — 3D wireframe chess.  Copyright (C) 2026 Scott Peterman
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.  It is distributed WITHOUT ANY WARRANTY; without even
// the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
// PURPOSE.  See the GNU General Public License for more details.
// You should have received a copy of the GPL along with this program; if not,
// see <https://www.gnu.org/licenses/>.  Vendored components keep their own
// licences — see THIRD-PARTY-NOTICES.md.
//
// WebGL rasterisation backend for Render3D. This is a BACKEND, not a second
// renderer: the camera, the ray picking, the input handling and the scene model
// all still live in render3d.js. Only the "turn world-space segments into lit
// pixels" step moves to the GPU. There is exactly one camera implementation in
// the codebase and this file matches it in a shader (see toCam below) -- if the
// two ever disagree, picking and drawing disagree, which is the class of bug
// that produced the inverted-pitch mess.
//
// WHY THIS IS SHAPED THE WAY IT IS
//
// 1. gl.lineWidth() is clamped to 1.0 by ANGLE, which is what Chrome uses on
//    every platform. So the Canvas2D glow -- three stacked strokes at 5.5/2.6/1.0
//    -- has no direct equivalent. Instead every segment is drawn as an INSTANCED
//    QUAD expanded to screen width in the vertex shader, and the fragment shader
//    computes true distance-to-segment and applies a core+halo falloff. That
//    gives round caps and correct joints for free, and the glow is a smooth
//    function rather than three discrete passes.
//
// 2. Geometry is uploaded ONCE, at init, as six static buffers -- one per piece
//    type. A position is 32 draw calls with a different offset uniform each; a
//    move is a uniform changing. Nothing is rebuilt, re-flattened or re-uploaded
//    when the camera moves or a piece slides. That is the whole point: the
//    Canvas2D path spends ~12ms a frame building Path2Ds, and this spends none.
//
// 3. Depth fade is computed per-vertex from camera-space z over a range fitted
//    to the actual scene, not six fixed bands over a range the board never
//    reaches.
//
// Depends on globals: Pieces (js/pieces.js). Used by Render3D (js/render3d.js).

(function (global) {
  'use strict';

  // ------------------------------------------------------------------ shaders
  // GLSL ES 1.00 -- valid in both WebGL1 and WebGL2, so one shader source
  // serves whichever context we get.

  const VS = `
precision highp float;

attribute vec2 aCorner;   // x: which endpoint (0|1). y: which side (-1|+1).
attribute vec3 aA;        // per-instance: segment start, model space
attribute vec3 aB;        // per-instance: segment end

uniform vec4  uCS;        // cos(yaw), sin(yaw), cos(pitch), sin(pitch)
uniform vec4  uCam;       // targetY, dist, focalPx, nearZ
uniform vec2  uView;      // canvas size in CSS px
uniform vec3  uOfs;       // world offset (x, y, z) -- piece placement + hop
uniform float uFlipZ;     // -1 mirrors the piece in z (Black faces the other way)
uniform float uYScale;    // -squash draws the reflection
uniform float uHalfW;     // half the quad width, CSS px
uniform vec2  uFade;      // camera z at full brightness, camera z at dimmest

varying vec2  vP;         // this fragment, in px
varying vec2  vA;         // segment endpoints, in px -- same for all 4 corners,
varying vec2  vB;         //   so interpolation hands the fragment exact values
varying float vFade;

vec3 toCam(vec3 m){
  // Mirrors Render3D.toCam exactly. Offset is applied in world space, and
  // uYScale multiplies the hop too so a reflected slide mirrors properly.
  vec3 w = vec3(m.x + uOfs.x, (m.y + uOfs.y) * uYScale, m.z * uFlipZ + uOfs.z);
  float dy = w.y - uCam.x;
  float x1 = w.x * uCS.x - w.z * uCS.y;
  float z1 = w.x * uCS.y + w.z * uCS.x;
  return vec3(x1, dy * uCS.z - z1 * uCS.w, dy * uCS.w + z1 * uCS.z + uCam.y);
}

vec2 toPx(vec3 c){
  float f = uCam.z / c.z;
  return vec2(uView.x * 0.5 + c.x * f, uView.y * 0.5 - c.y * f);
}

void main(){
  vec3 ca = toCam(aA);
  vec3 cb = toCam(aB);
  float nr = uCam.w;

  // Both endpoints behind the near plane: park the quad outside clip space.
  if (ca.z < nr && cb.z < nr) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  // One endpoint behind: slide it up to the near plane, same as the CPU path.
  if (ca.z < nr)      { ca = mix(ca, cb, (nr - ca.z) / (cb.z - ca.z)); }
  else if (cb.z < nr) { cb = mix(cb, ca, (nr - cb.z) / (ca.z - cb.z)); }

  vec2 pa = toPx(ca), pb = toPx(cb);
  vec2 d  = pb - pa;
  float L = length(d);
  vec2 dir = L > 1e-5 ? d / L : vec2(1.0, 0.0);   // a zero-length segment is a
  vec2 nrm = vec2(-dir.y, dir.x);                 //   dot: the cap draws it

  // Expand: along the line past both ends by uHalfW (so the round caps have
  // room), and sideways by uHalfW.
  vec2 p = mix(pa, pb, aCorner.x)
         + dir * ((aCorner.x * 2.0 - 1.0) * uHalfW)
         + nrm * (aCorner.y * uHalfW);

  vP = p; vA = pa; vB = pb;
  float cz = (ca.z + cb.z) * 0.5;
  vFade = clamp((uFade.y - cz) / max(uFade.y - uFade.x, 1e-4), 0.0, 1.0);

  gl_Position = vec4((p.x / uView.x) * 2.0 - 1.0,
                     1.0 - (p.y / uView.y) * 2.0, 0.0, 1.0);
}`;

  const FS = `
precision highp float;

varying vec2  vP;
varying vec2  vA;
varying vec2  vB;
varying float vFade;

uniform vec3  uColor;
uniform float uAlpha;
uniform float uFadeAmt;   // how much the far end dims (0 = no depth cue)
uniform vec2  uGlow;      // core sigma px, halo falloff px
uniform float uHalo;      // halo weight

void main(){
  // True distance to the SEGMENT, so caps are round and joints do not notch.
  vec2 ab = vB - vA;
  float t = clamp(dot(vP - vA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float d = length(vP - (vA + ab * t));

  float core = exp(-(d * d) / (uGlow.x * uGlow.x));
  float halo = exp(-d / uGlow.y);
  float i = core + halo * uHalo;

  float fade = mix(1.0 - uFadeAmt, 1.0, vFade);
  float a = clamp(i * uAlpha * fade, 0.0, 1.0);
  // PREMULTIPLIED, because the blend equation is MAX, not add -- see the note
  // on blending in create(). Under MAX the framebuffer keeps the brightest
  // contribution rather than summing them, so the source has to already carry
  // its own intensity in the colour channels.
  gl_FragColor = vec4(uColor * a, a);
}`;

  // ------------------------------------------------------------------ helpers
  function hexRGB(h) {
    const n = parseInt(h.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function compile(gl, type, src, log) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      log('WebGL shader failed: ' + gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  function segBuffer(gl, arr) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
    return { buf: b, count: arr.length / 6 };
  }

  // ------------------------------------------------------------------ backend
  function create(canvas, log) {
    log = log || function () {};
    const opts = { alpha: false, antialias: false, depth: false, stencil: false,
                   premultipliedAlpha: false, powerPreference: 'high-performance',
                   preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false };

    let gl = canvas.getContext('webgl2', opts);
    let instanced = null, ver = 2;
    if (gl) {
      instanced = { arrays: gl.drawArraysInstanced.bind(gl),
                    divisor: gl.vertexAttribDivisor.bind(gl) };
    } else {
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
      ver = 1;
      if (!gl) { log('WebGL unavailable - staying on Canvas2D.'); return null; }
      const ext = gl.getExtension('ANGLE_instanced_arrays');
      if (!ext) { log('WebGL1 without ANGLE_instanced_arrays - staying on Canvas2D.'); return null; }
      instanced = { arrays: ext.drawArraysInstancedANGLE.bind(ext),
                    divisor: ext.vertexAttribDivisorANGLE.bind(ext) };
    }

    // Report what we actually got. This is the answer to "is my Chromebook
    // hardware-accelerating this or falling back to software", without leaving
    // the page for chrome://gpu.
    let rendererName = 'unknown';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) rendererName = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || 'unknown';
    const soft = /swiftshader|llvmpipe|software|basic render/i.test(rendererName);
    log('WebGL' + ver + ' ready: ' + rendererName);
    if (soft) log('WARNING: that is a SOFTWARE rasteriser. WebGL will not be faster here.');

    const vs = compile(gl, gl.VERTEX_SHADER, VS, log);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FS, log);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      log('WebGL link failed: ' + gl.getProgramInfoLog(prog));
      return null;
    }
    gl.useProgram(prog);

    const A = { corner: gl.getAttribLocation(prog, 'aCorner'),
                a: gl.getAttribLocation(prog, 'aA'),
                b: gl.getAttribLocation(prog, 'aB') };
    const U = {};
    for (const n of ['uCS','uCam','uView','uOfs','uFlipZ','uYScale','uHalfW',
                     'uFade','uColor','uAlpha','uFadeAmt','uGlow','uHalo'])
      U[n] = gl.getUniformLocation(prog, n);

    // Unit quad, shared by every segment ever drawn.
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([0,-1, 0,1, 1,-1, 1,1]), gl.STATIC_DRAW);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // BLENDING: MAX, NOT ADD. This is the one place where a naive port of the
    // Canvas2D look is badly wrong, and it is not obvious.
    //
    // Canvas2D batches a whole depth band into ONE Path2D and strokes it once.
    // Overlapping segments inside that single stroke do NOT accumulate -- the
    // rasteriser fills their union at the pass alpha. GL draws every segment
    // separately, so plain additive blending sums hundreds of overlapping
    // contributions inside a piece and every piece saturates to a white blob.
    //
    // gl.MAX reproduces the union semantics exactly: the framebuffer keeps the
    // brightest contribution at each pixel. Additive is the fallback, with the
    // alpha pulled down hard, for the rare context that has neither.
    let blendMode = 'max';
    if (ver === 2) {
      gl.blendEquation(gl.MAX);
    } else {
      const mm = gl.getExtension('EXT_blend_minmax');
      if (mm) gl.blendEquation(mm.MAX_EXT);
      else { gl.blendFunc(gl.SRC_ALPHA, gl.ONE); blendMode = 'add'; }
    }
    if (blendMode === 'add') log('No MAX blend here - glow will be additive and hotter.');

    const B = {
      gl, prog, A, U, quad, instanced, rendererName, software: soft, blendMode,
      W: 1, H: 1, DPR: 1, lost: false,
      meshes: {}, lo: {}, board: null, hi: null, motes: null, _hiKey: '',
      placement: [], segCount: 0,

      // ---- one-time geometry upload ----
      uploadMeshes(boardGeo, motes) {
        for (const k of Pieces.PIECES) {
          this.meshes[k] = segBuffer(gl, Pieces.geo[k]);
          // Reflections use the low-detail mesh, same as Canvas2D. Not for
          // speed here -- at 24% alpha the full mesh's ring density fills in
          // solid and the reflection reads as a grey smudge instead of a wire.
          this.lo[k] = segBuffer(gl, Pieces.lo[k]);
        }
        this.board = segBuffer(gl, boardGeo);
        // Motes are zero-length segments: the fragment cap draws them as dots.
        const m = [];
        for (const p of motes) m.push(p[0], p[1], p[2], p[0], p[1], p[2]);
        this.motes = segBuffer(gl, m);
        this.hi = { buf: gl.createBuffer(), count: 0 };
        let n = 0;
        for (const k of Pieces.PIECES) n += this.meshes[k].count;
        log('WebGL geometry uploaded: ' + n + ' unique segments, ' +
            Pieces.PIECES.length + ' meshes.');
      },

      // Density changed, so the six static meshes are stale. Delete before
      // re-creating: segBuffer allocates, and dropping the old handles on the
      // floor leaks a full board's geometry per slider release.
      reuploadPieces() {
        for (const k of Pieces.PIECES) {
          if (this.meshes[k]) gl.deleteBuffer(this.meshes[k].buf);
          if (this.lo[k]) gl.deleteBuffer(this.lo[k].buf);
          this.meshes[k] = segBuffer(gl, Pieces.geo[k]);
          this.lo[k] = segBuffer(gl, Pieces.lo[k]);
        }
        this.setPlacement(this.placement);   // segCount follows the mesh counts
      },

      setPlacement(list) {
        // Sorted by piece type so the buffer bind changes at most six times.
        this.placement = list.slice().sort((p, q) => p.name < q.name ? -1 : p.name > q.name ? 1 : 0);
        let n = this.board.count;
        for (const p of this.placement) n += this.meshes[p.name].count;
        this.segCount = n;
      },

      resize(W, H, DPR) {
        this.W = W; this.H = H; this.DPR = DPR;
        canvas.width = Math.round(W * DPR);
        canvas.height = Math.round(H * DPR);
        gl.viewport(0, 0, canvas.width, canvas.height);
      },

      // ---- per-frame ----
      _bind(mesh) {
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
        gl.enableVertexAttribArray(A.a);
        gl.enableVertexAttribArray(A.b);
        gl.vertexAttribPointer(A.a, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(A.b, 3, gl.FLOAT, false, 24, 12);
        instanced.divisor(A.a, 1);
        instanced.divisor(A.b, 1);
      },
      _drawMesh(mesh, ofs, flipZ, yScale, colour, alpha, halfW) {
        if (!mesh.count) return;
        this._bind(mesh);
        gl.uniform3f(U.uOfs, ofs[0], ofs[1], ofs[2]);
        gl.uniform1f(U.uFlipZ, flipZ);
        gl.uniform1f(U.uYScale, yScale);
        gl.uniform1f(U.uHalfW, halfW);
        gl.uniform3fv(U.uColor, colour);
        gl.uniform1f(U.uAlpha, alpha);
        instanced.arrays(gl.TRIANGLE_STRIP, 0, 4, mesh.count);
      },

      draw(R) {
        if (this.lost) return;
        const T = R.TUNE, c = R.cam;
        const bg = hexRGB(T.color.bg || '#02040c');
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(A.corner);
        gl.vertexAttribPointer(A.corner, 2, gl.FLOAT, false, 0, 0);
        instanced.divisor(A.corner, 0);

        const f0 = T.cam.focal * Math.min(this.W, this.H);
        gl.uniform4f(U.uCS, Math.cos(c.yaw), Math.sin(c.yaw),
                            Math.cos(c.pitch), -Math.sin(c.pitch));
        gl.uniform4f(U.uCam, c.targetY, c.dist, f0, T.cam.near);
        gl.uniform2f(U.uView, this.W, this.H);
        // Depth fade fitted to the scene instead of six fixed bands: the board
        // spans roughly +-half its diagonal in camera z around the eye distance.
        const span = T.depth.span || 6.5;
        gl.uniform2f(U.uFade, c.dist - span, c.dist + span);
        gl.uniform1f(U.uFadeAmt, T.depth.falloff);
        gl.uniform2f(U.uGlow, T.glow.core, T.glow.halo);
        gl.uniform1f(U.uHalo, T.glow.strength * 0.34);

        const LIGHT = hexRGB(T.color.light), DARK = hexRGB(T.color.dark);
        // The additive fallback sums overlaps, so it needs far less ink per
        // segment to land in the same place visually.
        const AS = this.blendMode === 'add' ? 0.22 : 1.0;
        const HW = T.glow.widthPx;

        this._drawMesh(this.board, [0,0,0], 1, 1, hexRGB(T.color.board), 0.75*AS, HW);

        if (T.refl.on) {
          for (const p of this.placement)
            this._drawMesh(this.lo[p.name], [p.x, 0, p.z], p.flip ? -1 : 1,
                           -T.refl.squash, p.colour === 'w' ? LIGHT : DARK,
                           T.refl.alpha*AS, HW * 0.8);
        }

        this._uploadHighlights(R);
        this._drawMesh(this.hi, [0,0,0], 1, 1, hexRGB(T.color.target), AS, HW);

        for (const p of this.placement)
          this._drawMesh(this.meshes[p.name], [p.x, 0, p.z], p.flip ? -1 : 1, 1,
                         p.colour === 'w' ? LIGHT : DARK, AS, HW);

        if (R.anim) {
          const a = R.anim;
          let k = (performance.now() - a.t0) / T.anim.ms;
          k = k < 0 ? 0 : k > 1 ? 1 : k;
          const e = k < 0.5 ? 2*k*k : 1 - Math.pow(-2*k + 2, 2) / 2;
          const ofs = [a.from.x + (a.to.x - a.from.x) * e,
                       Math.sin(Math.PI * e) * 0.35,
                       a.from.z + (a.to.z - a.from.z) * e];
          this._drawMesh(this.meshes[a.name], ofs, a.flip ? -1 : 1, 1,
                         a.flip ? DARK : LIGHT, AS, HW);
        }

        if (T.motes.on)
          this._drawMesh(this.motes, [0,0,0], 1, 1, hexRGB(T.color.mote), 0.5*AS, 1.6);
      },

      // Highlights are the only geometry that changes without a move, and there
      // are a few hundred segments of it. Re-upload only when it actually differs.
      _uploadHighlights(R) {
        const key = (R.selected || '-') + '|' + R.targets.map(t => t.to).join('') +
                    '|' + (R.lastMove ? R.lastMove.from + R.lastMove.to : '-');
        if (key === this._hiKey) return;
        this._hiKey = key;
        const geo = R.highlightGeo();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.hi.buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo), gl.DYNAMIC_DRAW);
        this.hi.count = geo.length / 6;
      },

      destroy() {
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    };

    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); B.lost = true;
      log('WebGL context lost - switch to Canvas2D to keep playing.');
    });

    return B;
  }

  global.GLRender = { create };
})(window);
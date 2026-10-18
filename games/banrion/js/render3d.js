// banrion/js/render3d.js
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
// The wireframe board. Camera, scene assembly, draw loop, and picking.
//
// Two things worth knowing before editing:
//
// 1. PICKING IS A RAY, NOT A PROJECTION. Un-project the pointer into a world
//    ray and intersect the y=0 plane; that lands directly on a square. The
//    alternative -- projecting 64 quads to screen and hit-testing them -- has
//    to special-case squares near the horizon and gives two sources of truth
//    for screen<->world. One inverse of the camera, used by both.
//
// 2. SEGMENTS ARE FLATTENED INTO BUCKETS, NOT DRAWN PER PIECE. That batching
//    is what keeps this fast (~45 stroke calls a frame regardless of segment
//    count). So the static pieces are flattened once when the position
//    changes, and only an animating piece is rebuilt per frame.
//
// 3. RASTERISATION IS A SWAPPABLE BACKEND. Everything above -- camera, picking,
//    scene assembly, input -- is shared. Only the step that turns world-space
//    segments into pixels differs between Canvas2D (here) and WebGL
//    (js/glrender.js). One camera, one picker, one scene model, two rasterisers.
//
// Depends on globals: Pieces (js/pieces.js), Game (js/game.js).
// Optional: GLRender (js/glrender.js) -- absent means Canvas2D, nothing breaks.

(function (global) {
  'use strict';

  const TUNE = {
    cam:   { yaw:0.0, pitch:0.92, dist:15.0, targetY:0.28, focal:1.25, near:0.12,
             minPitch:0.18, maxPitch:1.45, minDist:5.0, maxDist:30,
             // Standing rotation away from your own army, in radians. Edit
             // THIS, never yaw -- anything written to yaw is overwritten by
             // the next faceSide() or resetView().
             turn: 0.0,
             // Zoom per PIXEL of scroll, not per event. A mouse notch is one
             // event of ~100px; a trackpad flick is a burst of twenty events
             // of ~5px. Reacting per event makes the two differ by 20x, which
             // is what "hyper sensitive" was. At this gain a notch is ~1.16x
             // and each trackpad step is ~1.008x, so a gesture of either
             // travels about the same distance.
             wheelGain: 0.0015,
             wheelMax: 240,        // px of scroll honoured from one event
             pinchGain: 0.85 },    // <1 damps pinch slightly; 1 is raw finger ratio
    // passes[] is the Canvas2D glow (three stacked strokes). core/halo/widthPx
    // are the GL equivalent: one quad per segment, falloff computed per pixel.
    glow:  { strength:0.85, passes:[[5.5,0.055],[2.6,0.13],[1.0,0.90]],
             core:1.15, halo:2.6, widthPx:5.5 },
    // bands/near/far drive the Canvas2D path. span drives GL: the fade range is
    // cam.dist +- span, so it tracks the camera instead of sitting outside the
    // z range the board actually occupies.
    depth: { bands:6, near:2.5, far:26, falloff:0.55, span:6.5 },
    refl:  { on:true, alpha:0.24, squash:0.96, detail:0.45 },
    motes: { on:true, count:120, spread:26 },
    board: { sq:1.0, nodes:true },
    anim:  { ms:260 },
    color: { light:'#dff4ff', dark:'#ffb545', board:'#1f6fd0', mote:'#3aa8ff',
             pick:'#7fff8f', target:'#5fd0ff', last:'#ffb545', check:'#ff5240',
             bg:'#02040c' },  // GL owns its own clear; the 2D canvas is transparent
    // PIECES ONLY. The grid, the motes and the highlight colours are not part
    // of this -- picking a side colour recolours one army and nothing else.
    // Two independent picks from one list, never a coupled palette.
    sides: { w:'ice', b:'amber' },
    swatches: {                                   // lifted from the lab, verbatim
      ice:      { label:'ICE',       hex:'#dff4ff' },
      cyan:     { label:'CYAN',      hex:'#7fdcff' },
      blue:     { label:'BLUE',      hex:'#2f6dff' },
      gold:     { label:'GOLD',      hex:'#ffe08a' },
      amber:    { label:'AMBER',     hex:'#ffb545' },
      brass:    { label:'BRASS',     hex:'#b8891f' },
      ember:    { label:'EMBER',     hex:'#d1660a' },
      lime:     { label:'LIME',      hex:'#b6ff9c' },
      crt:      { label:'CRT GREEN', hex:'#3dff6b' },
      phosphor: { label:'PHOSPHOR',  hex:'#17a34a' },
      coral:    { label:'CORAL',     hex:'#ffab99' },
      plasma:   { label:'PLASMA',    hex:'#ff5240' },
      crimson:  { label:'CRIMSON',   hex:'#c81e12' },
      violet:   { label:'VIOLET',    hex:'#c88cff' },
      indigo:   { label:'INDIGO',    hex:'#7c3aed' }
    }
  };

  // applyView() writes the saved framing INTO TUNE.cam, so the shipped values
  // have to be kept somewhere or "go back to the default" has nothing to go
  // back to. Snapshotted once, never written.
  const SHIPPED_CAM = Object.assign({}, TUNE.cam);

  const FILES = 'abcdefgh';
  const SQ = TUNE.board.sq;
  const HALF = 8 * SQ / 2;

  // board square -> world centre. Files run +x, ranks run +z.
  function worldOf(square) {
    const f = FILES.indexOf(square[0]), r = parseInt(square[1], 10) - 1;
    return { x: -HALF + SQ / 2 + f * SQ, z: -HALF + SQ / 2 + r * SQ };
  }
  function squareOfWorld(x, z) {
    const f = Math.floor((x + HALF) / SQ), r = Math.floor((z + HALF) / SQ);
    if (f < 0 || f > 7 || r < 0 || r > 7) return null;
    return FILES[f] + (r + 1);
  }

  const R = {
    cv: null, ctx: null, W: 0, H: 0, DPR: 1,
    cam: Object.assign({}, TUNE.cam),
    TUNE,

    selected: null, targets: [], lastMove: null,
    anim: null,                 // {piece, from:{x,z}, to:{x,z}, t0}
    _dirty: true, _raf: 0,

    // 'gl' or '2d'. Both draw the same scene through the same camera; only the
    // rasterisation differs. See js/glrender.js.
    mode: '2d', gpu: null, log: function () {},
    fps: 0, _fpsT: 0, _fpsN: 0,

    // ---------------------------------------------------------------- setup
    init(canvas, opts) {
      this.cv = canvas;
      this.log = (opts && opts.log) || function () {};
      Pieces.build(TUNE.refl.detail);
      this.buildBoard();
      this.buildMotes();
      this._makeContext((opts && opts.backend) || 'auto');
      this.bindInput();
      if (!this._onResize) {
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
      }
      this.resize();
      this._loop();
      return this;
    },

    // A canvas is bound to one context type for life, so switching backends
    // means replacing the element. Everything the shell holds is looked up by
    // id, and input is rebound below, so the swap is invisible from outside.
    _swapCanvas() {
      const old = this.cv, nw = document.createElement('canvas');
      nw.id = old.id; nw.className = old.className;
      nw.style.cssText = old.style.cssText;
      if (old.hasAttribute('hidden')) nw.setAttribute('hidden', '');
      old.parentNode.replaceChild(nw, old);
      this.cv = nw;
    },

    _makeContext(want) {
      this.gpu = null; this.ctx = null;
      if (want !== '2d' && global.GLRender) {
        const g = GLRender.create(this.cv, m => this.log(m));
        if (g) {
          g.uploadMeshes(this.boardGeo, this.motes);
          this.gpu = g; this.mode = 'gl';
          return this.mode;
        }
        // create() may have taken a webgl context before failing, which poisons
        // the element for getContext('2d'). Start over with a fresh one.
        this._swapCanvas();
      }
      this.ctx = this.cv.getContext('2d');
      this.mode = '2d';
      return this.mode;
    },

    // Returns the mode actually in force -- asking for 'gl' on a machine without
    // it lands on '2d', and the caller should say so rather than lie in the UI.
    setBackend(want) {
      if (want === this.mode) return this.mode;
      cancelAnimationFrame(this._raf);
      if (this.gpu) { this.gpu.destroy(); this.gpu = null; }
      this._swapCanvas();
      this._makeContext(want);
      this.bindInput();
      this.resize();
      this.setPosition(Game.board());
      this._dirty = true;
      this._loop();
      return this.mode;
    },

    _loop() {
      const step = () => { this.frame(); this._raf = requestAnimationFrame(step); };
      this._raf = requestAnimationFrame(step);
    },

    resize() {
      const rect = this.cv.getBoundingClientRect();
      this.DPR = Math.min(window.devicePixelRatio || 1, 2);
      this.W = Math.max(1, Math.round(rect.width));
      this.H = Math.max(1, Math.round(rect.height));
      if (this.gpu) {
        this.gpu.resize(this.W, this.H, this.DPR);
      } else {
        this.cv.width = this.W * this.DPR;
        this.cv.height = this.H * this.DPR;
        this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      }
      this._dirty = true;
    },

    // ------------------------------------------------------------- visuals
    // Colour of one army. Both backends read TUNE.color fresh every frame, so
    // this is a repaint, not a rebuild -- no geometry is touched.
    setSide(colour, key) {
      if (!TUNE.swatches[key]) return null;
      TUNE.sides[colour] = key;
      TUNE.color[colour === 'w' ? 'light' : 'dark'] = TUNE.swatches[key].hex;
      this._dirty = true;
      return key;
    },

    // Anything that changes the MESH goes through here: new segments, and on GL
    // new buffers. Everything else in the visuals panel is a uniform or an
    // alpha and costs a frame, not a rebuild.
    _rebuild() {
      Pieces.build(TUNE.refl.detail);
      if (this.gpu) this.gpu.reuploadPieces();
      this.setPosition(Game.board());
    },
    setDensity(patch) {
      Pieces.setDensity(patch);
      this._rebuild();
      return Pieces.DENSITY;
    },
    // Degrees the knight is turned from the file axis toward the opponent.
    setKnightYaw(deg) {
      const v = Pieces.setKnightYaw(deg);
      this._rebuild();
      return v;
    },

    // Each player sits behind their own army.
    // YAW IS DERIVED, NOT STORED. What a player actually wants to keep is how
    // far round from their own army they like to sit -- TUNE.cam.turn -- not an
    // absolute yaw, which would put Black behind White's back. Every framing
    // goes through here, so the saved view works for either colour.
    faceSide(colour) {
      this.cam.yaw = (colour === 'b' ? Math.PI : 0) + (TUNE.cam.turn || 0);
      this._dirty = true;
    },

    // The camera as something worth saving: an offset from your own side,
    // plus the parts that have no handedness.
    captureView() {
      const base = this._nearestSide();
      let turn = this.cam.yaw - base;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));    // wrap to (-pi, pi]
      return { turn, pitch: this.cam.pitch, dist: this.cam.dist,
               targetY: this.cam.targetY };
    },
    applyView(v) {
      if (!v) return;
      const num = (x, lo, hi, d) => (typeof x === 'number' && isFinite(x))
        ? Math.min(hi, Math.max(lo, x)) : d;
      TUNE.cam.turn    = num(v.turn, -Math.PI, Math.PI, TUNE.cam.turn || 0);
      TUNE.cam.pitch   = num(v.pitch, TUNE.cam.minPitch, TUNE.cam.maxPitch, TUNE.cam.pitch);
      TUNE.cam.dist    = num(v.dist, TUNE.cam.minDist, TUNE.cam.maxDist, TUNE.cam.dist);
      TUNE.cam.targetY = num(v.targetY, -2, 4, TUNE.cam.targetY);
      this.resetView();
    },

    // Forget a saved view and return to the shipped framing.
    clearView() {
      for (const k of ['turn', 'pitch', 'dist', 'targetY']) TUNE.cam[k] = SHIPPED_CAM[k];
      this.resetView();
    },

    // Which army are we currently sitting behind? Used so a saved turn is
    // measured from the near side rather than from White in all cases.
    _nearestSide() {
      const d = Math.atan2(Math.sin(this.cam.yaw - Math.PI),
                           Math.cos(this.cam.yaw - Math.PI));
      return Math.abs(d) < Math.PI / 2 ? Math.PI : 0;
    },

    // ---------------------------------------------------------------- camera
    _cache() {
      this._cy = Math.cos(this.cam.yaw); this._sy = Math.sin(this.cam.yaw);
      this._cp = Math.cos(this.cam.pitch);
      // NOTE the minus. The lab's transform maps "farther" to "lower on
      // screen", i.e. an eye BELOW the board looking up. It never showed there
      // because the lab's default yaw is 0.62, so no axis is seen head-on. A
      // chess board is viewed square-on down the rank axis, where it is glaring
      // -- the near army lands at the top of the screen and the two sides swap.
      this._sp = -Math.sin(this.cam.pitch);
      this._f0 = TUNE.cam.focal * Math.min(this.W, this.H);
    },
    toCam(x, y, z, o) {
      const dy = y - this.cam.targetY;
      const x1 = x * this._cy - z * this._sy;
      const z1 = x * this._sy + z * this._cy;
      o[0] = x1;
      o[1] = dy * this._cp - z1 * this._sp;
      o[2] = dy * this._sp + z1 * this._cp + this.cam.dist;
    },

    // Exact inverse of toCam + perspective divide, for one screen point.
    // Returns the board square under the pointer, or null.
    pickSquare(px, py) {
      this._cache();
      // screen -> camera-space ray direction (camera sits at the origin)
      const dx = (px - this.W / 2) / this._f0;
      const dy = -(py - this.H / 2) / this._f0;
      // undo the camera transform on both the eye and the ray
      const un = (cx, cy, cz) => {
        const ty = cy * this._cp + (cz) * this._sp;
        const z1 = -cy * this._sp + (cz) * this._cp;
        const x1 = cx;
        return {
          x:  x1 * this._cy + z1 * this._sy,
          y:  ty + this.cam.targetY,
          z: -x1 * this._sy + z1 * this._cy
        };
      };
      const eye = un(0, 0, -this.cam.dist);
      const at  = un(dx, dy, 1 - this.cam.dist);
      const vy = at.y - eye.y;
      if (Math.abs(vy) < 1e-9) return null;      // ray parallel to the board
      const t = (0 - eye.y) / vy;
      if (t <= 0) return null;                   // plane is behind the camera
      return squareOfWorld(eye.x + (at.x - eye.x) * t,
                           eye.z + (at.z - eye.z) * t);
    },

    // ---------------------------------------------------------------- scene
    buildBoard() {
      const out = [];
      for (let i = 0; i <= 8; i++) {
        const p = -HALF + i * SQ;
        out.push(-HALF, 0, p, HALF, 0, p);
        out.push(p, 0, -HALF, p, 0, HALF);
      }
      this.boardGeo = out;
    },
    buildMotes() {
      this.motes = [];
      const s = TUNE.motes.spread;
      for (let i = 0; i < TUNE.motes.count; i++)
        this.motes.push([(Math.random() - 0.5) * s, Math.random() * s * 0.5 + 0.4,
                         (Math.random() - 0.5) * s, Math.random() * 1.6 + 0.5]);
    },

    // Flatten the position into two big arrays. Called on position change, not
    // per frame. An animating piece is excluded here and drawn separately.
    // Two representations of the same position. GL wants the structured list --
    // it draws six uploaded meshes with a different offset uniform each, so it
    // never needs the geometry duplicated per square. Canvas2D wants it
    // duplicated and flattened, because batching into Path2Ds is what makes it
    // bearable. Only the one in use is built.
    setPosition(rows) {
      const light = [], dark = [], lightR = [], darkR = [], place = [];
      const gpu = this.gpu;
      const skip = this.anim ? this.anim.square : null;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const p = rows[r][c];
          if (!p) continue;
          const sq = FILES[c] + (8 - r);
          if (sq === skip) continue;
          const w = worldOf(sq);
          const name = Pieces.NAME[p.type];
          // Black's pieces are mirrored in z so the knights face each other.
          if (gpu) {
            place.push({ name, x: w.x, z: w.z, flip: p.color === 'b', colour: p.color });
            continue;
          }
          const hi = p.color === 'w' ? light : dark;
          const lo = p.color === 'w' ? lightR : darkR;
          addTranslated(hi, Pieces.geo[name], w.x, w.z, p.color === 'b');
          addTranslated(lo, Pieces.lo[name],  w.x, w.z, p.color === 'b');
        }
      }
      this.placement = place;
      if (gpu) {
        gpu.setPlacement(place);
        this.scene = { light, dark, lightR, darkR };
        this.segCount = gpu.segCount;
      } else {
        this.scene = { light, dark, lightR, darkR };
        this.segCount = (light.length + dark.length + this.boardGeo.length) / 6;
      }
      this._dirty = true;
    },

    // ---------------------------------------------------------------- moves
    // Slide a piece between squares, then hand back to the flat scene.
    animate(from, to, type, colour, onDone) {
      this.anim = { square: to, name: Pieces.NAME[type], flip: colour === 'b',
                    from: worldOf(from), to: worldOf(to), t0: performance.now(),
                    done: onDone };
      this.setPosition(Game.board());
    },

    // ---------------------------------------------------------------- draw
    // Snap an in-flight slide to its end. Called by frame() when the clock runs
    // out, and by the shell when a click arrives mid-animation -- a player who
    // clicks during the slide should have the click land, not be swallowed.
    // It also matters that this is reachable OUTSIDE the rAF loop: rAF is
    // throttled in a background tab, so a flag cleared only there can stay set
    // long after the animation should have ended.
    finishAnim() {
      if (!this.anim) return;
      const done = this.anim.done;
      this.anim = null;
      this.setPosition(Game.board());
      if (done) done();
    },

    frame() {
      if (this._benching) return;      // measure() owns the clock while it runs
      let animating = false;
      if (this.anim) {
        const k = (performance.now() - this.anim.t0) / TUNE.anim.ms;
        if (k >= 1) this.finishAnim();
        else { animating = true; this._dirty = true; }
      }
      if (!this._dirty && !animating) return;
      this._dirty = false;
      this.draw();
      // Frame rate has to come from wall-clock deltas between frames that
      // actually rendered. Timing the draw call itself measures nothing:
      // Canvas2D defers rasterisation and GL defers everything.
      const now = performance.now();
      this._fpsN++;
      if (now - this._fpsT > 500) {
        this.fps = this._fpsN * 1000 / (now - this._fpsT);
        this._fpsT = now; this._fpsN = 0;
      }
    },

    // Spin at full rate for a fixed wall-clock window and report the average.
    // Orbits a little so nothing can be skipped as unchanged.
    measure(ms, done) {
      const t0 = performance.now(), yaw0 = this.cam.yaw;
      let n = 0;
      this._benching = true;
      const step = () => {
        const el = performance.now() - t0;
        this.cam.yaw = yaw0 + el * 0.0004;
        this._dirty = true; this.draw(); n++;
        if (el < (ms || 2000)) requestAnimationFrame(step);
        else {
          this._benching = false;
          this.cam.yaw = yaw0; this._dirty = true;
          done({ fps: n * 1000 / el, frames: n, ms: el,
                 mode: this.mode, segs: this.segCount,
                 gpu: this.gpu ? this.gpu.rendererName : 'n/a' });
        }
      };
      requestAnimationFrame(step);
    },

    draw() {
      if (this.gpu) { this.gpu.draw(this); return; }
      const ctx = this.ctx;
      this._cache();
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      resetPaths(7);
      collect.call(this, 0, this.scene.light, 1);
      collect.call(this, 1, this.scene.dark, 1);
      collect.call(this, 2, this.boardGeo, 1);
      if (TUNE.refl.on) {
        collect.call(this, 3, this.scene.lightR, -TUNE.refl.squash);
        collect.call(this, 4, this.scene.darkR, -TUNE.refl.squash);
      }
      collect.call(this, 5, this.highlightGeo(), 1);
      if (this.anim) collect.call(this, 6, this.animGeo(), 1);

      this.drawMotes();
      strokeBucket.call(this, 2, TUNE.color.board, 0.75);
      if (TUNE.refl.on) {
        strokeBucket.call(this, 3, TUNE.color.light, TUNE.refl.alpha, true);
        strokeBucket.call(this, 4, TUNE.color.dark, TUNE.refl.alpha, true);
      }
      strokeBucket.call(this, 5, TUNE.color.target, 1);
      strokeBucket.call(this, 0, TUNE.color.light, 1);
      strokeBucket.call(this, 1, TUNE.color.dark, 1);
      if (this.anim) {
        strokeBucket.call(this, 6,
          this.anim.flip ? TUNE.color.dark : TUNE.color.light, 1);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    },

    animGeo() {
      const a = this.anim, out = [];
      let k = (performance.now() - a.t0) / TUNE.anim.ms;
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;  // ease
      const x = a.from.x + (a.to.x - a.from.x) * e;
      const z = a.from.z + (a.to.z - a.from.z) * e;
      const hop = Math.sin(Math.PI * e) * 0.35;      // lift, so it reads as a move
      const src = Pieces.geo[a.name];
      for (let i = 0; i < src.length; i += 6) {
        const z0 = a.flip ? -src[i + 2] : src[i + 2];
        const z1 = a.flip ? -src[i + 5] : src[i + 5];
        out.push(src[i] + x, src[i + 1] + hop, z0 + z,
                 src[i + 3] + x, src[i + 4] + hop, z1 + z);
      }
      return out;
    },

    // Selection, legal destinations, last move and check -- flat rings on y=0.
    highlightGeo() {
      const out = [];
      const ring = (sq, rad, n, y) => {
        const w = worldOf(sq);
        for (let i = 0; i < n; i++) {
          const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
          out.push(w.x + Math.cos(a0) * rad, y, w.z + Math.sin(a0) * rad,
                   w.x + Math.cos(a1) * rad, y, w.z + Math.sin(a1) * rad);
        }
      };
      const box = (sq, half, y) => {
        const w = worldOf(sq), c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let i = 0; i < 4; i++) {
          const a = c[i], b = c[(i + 1) % 4];
          out.push(w.x + a[0] * half, y, w.z + a[1] * half,
                   w.x + b[0] * half, y, w.z + b[1] * half);
        }
      };
      if (this.lastMove) { box(this.lastMove.from, SQ * 0.46, 0.004);
                           box(this.lastMove.to, SQ * 0.46, 0.004); }
      if (this.selected) box(this.selected, SQ * 0.46, 0.008);
      for (const t of this.targets)
        ring(t.to, t.captured ? SQ * 0.42 : SQ * 0.14, t.captured ? 20 : 12, 0.008);
      return out;
    },

    drawMotes() {
      if (!TUNE.motes.on) return;
      const ctx = this.ctx, o = [0, 0, 0];
      ctx.fillStyle = TUNE.color.mote;
      for (const m of this.motes) {
        this.toCam(m[0], m[1], m[2], o);
        if (o[2] < TUNE.cam.near) continue;
        const f = this._f0 / o[2];
        ctx.globalAlpha = Math.min(0.5, 3.2 / o[2]);
        ctx.beginPath();
        ctx.arc(this.W / 2 + o[0] * f, this.H / 2 - o[1] * f,
                Math.max(0.6, m[3] * f * 0.006), 0, 6.2832);
        ctx.fill();
      }
    },

    // ---------------------------------------------------------------- input
    // One canvas serves both orbit-drag and select-click, so a click is
    // "pointer went down and up in nearly the same place" rather than any
    // pointerdown -- otherwise every small orbit would also select a square.
    // Called again after every canvas swap. The window-level listeners are the
    // trap: rebinding without removing the old pair leaves two orbit handlers
    // fighting over the same drag, which reads as the camera moving at double
    // speed. Keep the handles and tear them down first.
    bindInput() {
      if (this._win) {
        window.removeEventListener('pointermove', this._win.move);
        window.removeEventListener('pointerup', this._win.end);
      }
      const cv = this.cv;
      let down = false, moved = 0, lx = 0, ly = 0, sx = 0, sy = 0, pinch = 0;
      const pt = e => (e.touches ? e.touches[0] : e);

      const start = e => {
        const p = pt(e);
        down = true; moved = 0;
        lx = sx = p.clientX; ly = sy = p.clientY;
        if (e.touches && e.touches.length === 2) {
          pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                             e.touches[0].clientY - e.touches[1].clientY);
        }
      };
      const move = e => {
        if (e.touches && e.touches.length === 2) {
          const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                               e.touches[0].clientY - e.touches[1].clientY);
          if (pinch) this.zoom(Math.pow(pinch / d, TUNE.cam.pinchGain));
          pinch = d; moved = 999; e.preventDefault();
          return;
        }
        if (!down) return;
        const p = pt(e);
        const dx = p.clientX - lx, dy = p.clientY - ly;
        lx = p.clientX; ly = p.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > DRAG_SLOP) {
          this.cam.yaw -= dx * 0.006;
          this.cam.pitch = clamp(this.cam.pitch + dy * 0.005,
                                 TUNE.cam.minPitch, TUNE.cam.maxPitch);
          this._dirty = true;
          e.preventDefault();
        }
      };
      const end = e => {
        if (!down) return;
        down = false; pinch = 0;
        if (moved <= DRAG_SLOP) {
          const rect = cv.getBoundingClientRect();
          const sq = this.pickSquare(sx - rect.left, sy - rect.top);
          if (sq && this.onPick) this.onPick(sq);
        }
      };

      this._win = { move, end };
      cv.addEventListener('pointerdown', start);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      cv.addEventListener('touchstart', start, { passive: false });
      cv.addEventListener('touchmove', move, { passive: false });
      cv.addEventListener('touchend', end);
      cv.addEventListener('wheel', e => {
        // deltaMode: 0 = pixels, 1 = lines, 2 = pages. Firefox and some mice
        // report lines, so a raw deltaY is not comparable across devices.
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const px = clamp(e.deltaY * unit, -TUNE.cam.wheelMax, TUNE.cam.wheelMax);
        this.zoom(Math.exp(px * TUNE.cam.wheelGain));
        e.preventDefault();
      }, { passive: false });
    },

    zoom(k) {
      this.cam.dist = clamp(this.cam.dist * k, TUNE.cam.minDist, TUNE.cam.maxDist);
      this._dirty = true;
    },
    // Snap to the NEAREST side plus the standing turn, rather than freezing
    // whatever mid-orbit yaw happened to be current. Otherwise RESET VIEW
    // half-resets: it fixes the pitch and distance and leaves you facing
    // sideways.
    resetView() {
      const base = this._nearestSide();
      this.cam = Object.assign({}, TUNE.cam);
      this.cam.yaw = base + (TUNE.cam.turn || 0);
      this._dirty = true;
    }
  };

  const DRAG_SLOP = 6;        // px of travel that still counts as a click
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  function addTranslated(dst, src, dx, dz, flipZ) {
    for (let i = 0; i < src.length; i += 6) {
      const z0 = flipZ ? -src[i + 2] : src[i + 2];
      const z1 = flipZ ? -src[i + 5] : src[i + 5];
      dst.push(src[i] + dx, src[i + 1], z0 + dz,
               src[i + 3] + dx, src[i + 4], z1 + dz);
    }
  }

  // ---- batched stroking: one path per (bucket, depth band) ----
  let paths = [];
  function resetPaths(n) {
    paths = [];
    for (let i = 0; i < n; i++) {
      const bands = [];
      for (let b = 0; b < TUNE.depth.bands; b++) bands.push([]);
      paths.push(bands);
    }
  }
  function depthBand(z) {
    const { bands, near, far } = TUNE.depth;
    let t = (z - near) / (far - near); t = t < 0 ? 0 : t > 1 ? 1 : t;
    const b = Math.floor(t * bands);
    return b >= bands ? bands - 1 : b;
  }
  const _a = [0, 0, 0], _b = [0, 0, 0];
  function collect(bucket, arr, yScale) {
    const near = TUNE.cam.near, hw = this.W / 2, hh = this.H / 2, f0 = this._f0;
    for (let i = 0; i < arr.length; i += 6) {
      this.toCam(arr[i], arr[i + 1] * yScale, arr[i + 2], _a);
      this.toCam(arr[i + 3], arr[i + 4] * yScale, arr[i + 5], _b);
      let ax = _a[0], ay = _a[1], az = _a[2], bx = _b[0], by = _b[1], bz = _b[2];
      if (az < near && bz < near) continue;
      if (az < near) { const t = (near - az) / (bz - az);
                       ax += (bx - ax) * t; ay += (by - ay) * t; az = near; }
      else if (bz < near) { const t = (near - bz) / (az - bz);
                            bx += (ax - bx) * t; by += (ay - by) * t; bz = near; }
      const fa = f0 / az, fb = f0 / bz;
      paths[bucket][depthBand((az + bz) * 0.5)].push(
        hw + ax * fa, hh - ay * fa, hw + bx * fb, hh - by * fb);
    }
  }
  const CHEAP = [[1.3, 1.0]];
  function strokeBucket(bucket, colour, alphaScale, cheap) {
    const ctx = this.ctx, g = TUNE.glow.strength;
    const passes = cheap ? CHEAP : TUNE.glow.passes;
    for (let band = 0; band < TUNE.depth.bands; band++) {
      const pts = paths[bucket][band];
      if (!pts.length) continue;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 4) {
        ctx.moveTo(pts[i], pts[i + 1]); ctx.lineTo(pts[i + 2], pts[i + 3]);
      }
      const t = band / (TUNE.depth.bands - 1 || 1);
      const da = (1 - (1 - TUNE.depth.falloff) * t) * alphaScale;
      for (const [w, alpha] of passes) {
        const al = alpha * da * (w <= 1.31 ? 1 : g);
        if (al <= 0.004) continue;
        ctx.lineWidth = w; ctx.globalAlpha = al; ctx.strokeStyle = colour;
        ctx.stroke();
      }
    }
  }

  R.worldOf = worldOf;
  R.squareOfWorld = squareOfWorld;
  global.Render3D = R;
})(window);
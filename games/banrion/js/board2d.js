// banrion/js/board2d.js
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
// Placeholder board. Deliberately plain 2D: this exists to prove the state
// model and the network sync, and gets replaced by the piece-lab renderer once
// that is trustworthy. Everything it touches is behind Game, so the swap is a
// renderer change and nothing else.
//
// Picking is by square, not by piece -- project the square, hit-test the rect.
// That is the same approach the 3D version will use (project the 64 square
// corners, point-in-quad), so the interaction model carries over unchanged.
//
// Depends on globals: Game, onGameChanged.

(function (global) {
  'use strict';

  const GLYPH = {
    wk: '\u2654', wq: '\u2655', wr: '\u2656', wb: '\u2657', wn: '\u2658', wp: '\u2659',
    bk: '\u265A', bq: '\u265B', br: '\u265C', bb: '\u265D', bn: '\u265E', bp: '\u265F'
  };
  const FILES = 'abcdefgh';
  const PIECE_FONT = '"DejaVu Sans","Noto Sans Symbols 2","Segoe UI Symbol",serif';

  const Board2D = {
    cv: null, ctx: null, size: 0, cell: 0,
    ox: 0, oy: 0,              // letterbox offset of the square board in the canvas
    flipped: false,           // draw from Black's point of view
    selected: null,           // square string, e.g. 'e2'
    targets: [],              // legal destinations from `selected`
    lastMove: null,           // {from,to} for the trail highlight
    pendingPromo: null,       // {from,to} while the picker is up

    init(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
      window.addEventListener('resize', () => this.resize());
      this.resize();
    },

    // The canvas fills whatever box CSS gives it, and we draw a centred square
    // inside that. Sizing the BACKING STORE square while the CSS box is not
    // stretches the drawing on one axis, which silently desyncs the hit-test
    // from what is on screen -- that is what made clicks land columns away.
    // Letterboxing here means the two can never disagree, whatever CSS does.
    resize() {
      const rect = this.cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      this.cv.width = w * dpr;
      this.cv.height = h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.viewW = w; this.viewH = h;
      this.size = Math.min(w, h);
      this.ox = Math.floor((w - this.size) / 2);
      this.oy = Math.floor((h - this.size) / 2);
      this.cell = this.size / 8;
      this.draw();
    },

    // square <-> screen. One place, so flipping the board can never desync the
    // hit-test from the render.
    squareAt(px, py) {
      let c = Math.floor((px - this.ox) / this.cell),
          r = Math.floor((py - this.oy) / this.cell);
      if (c < 0 || c > 7 || r < 0 || r > 7) return null;
      if (this.flipped) { c = 7 - c; r = 7 - r; }
      return FILES[c] + (8 - r);
    },
    originOf(square) {
      let c = FILES.indexOf(square[0]), r = 8 - parseInt(square[1], 10);
      if (this.flipped) { c = 7 - c; r = 7 - r; }
      return { x: this.ox + c * this.cell, y: this.oy + r * this.cell };
    },

    onPointer(e) {
      const rect = this.cv.getBoundingClientRect();
      const sq = this.squareAt(e.clientX - rect.left, e.clientY - rect.top);
      if (sq && this.onPick) this.onPick(sq);
    },

    // selection state is owned by the shell (pickSquare/syncSelection) and
    // pushed in; this view only renders it.

    draw() {
      const ctx = this.ctx, s = this.cell;
      if (!ctx) return;
      ctx.clearRect(0, 0, this.viewW, this.viewH);

      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const x = this.ox + c * s, y = this.oy + r * s;
          const light = (r + c) % 2 === 0;
          ctx.fillStyle = light ? '#16233d' : '#0b1220';
          ctx.fillRect(x, y, s, s);
        }
      }

      if (this.lastMove) {
        ctx.fillStyle = '#ffb54522';
        for (const sq of [this.lastMove.from, this.lastMove.to]) {
          const o = this.originOf(sq);
          ctx.fillRect(o.x, o.y, s, s);
        }
      }

      if (this.selected) {
        const o = this.originOf(this.selected);
        ctx.fillStyle = '#5fd0ff33';
        ctx.fillRect(o.x, o.y, s, s);
        for (const t of this.targets) {
          const d = this.originOf(t.to);
          ctx.fillStyle = t.captured ? '#ff6b5266' : '#5fd0ff55';
          ctx.beginPath();
          ctx.arc(d.x + s / 2, d.y + s / 2, t.captured ? s * 0.42 : s * 0.14, 0, 6.2832);
          t.captured ? ctx.stroke() : ctx.fill();
          if (t.captured) { ctx.strokeStyle = '#ff6b52aa'; ctx.lineWidth = 2; ctx.stroke(); }
        }
      }

      // pieces
      // \uFE0E (variation selector-15) forces TEXT presentation. Without it the
      // system emoji font claims these code points and draws its own coloured
      // pieces, ignoring fillStyle -- so both sides come out the same colour.
      ctx.font = Math.floor(s * 0.78) + 'px ' + PIECE_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rows = Game.board();
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const p = rows[r][c];
          if (!p) continue;
          const sq = FILES[c] + (8 - r);
          const o = this.originOf(sq);
          // Same side colours as the 3D view. Read at draw time and guarded,
          // because board2d loads first and must still work on its own.
          const C = (window.Render3D && Render3D.TUNE.color) || null;
          ctx.fillStyle = p.color === 'w' ? (C ? C.light : '#dff4ff')
                                          : (C ? C.dark  : '#ffb545');
          ctx.fillText(GLYPH[p.color + p.type] + '\uFE0E',
                       o.x + s / 2, o.y + s / 2 + s * 0.03);
        }
      }

      // coordinates
      ctx.font = Math.floor(s * 0.18) + 'px ui-monospace,monospace';
      ctx.fillStyle = '#4a5a72';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < 8; i++) {
        const f = this.flipped ? FILES[7 - i] : FILES[i];
        const n = this.flipped ? i + 1 : 8 - i;
        ctx.fillText(f, this.ox + i * s + s * 0.06, this.oy + this.size - s * 0.22);
        ctx.fillText(n, this.ox + s * 0.06, this.oy + i * s + s * 0.05);
      }
    }
  };

  global.Board2D = Board2D;
})(window);

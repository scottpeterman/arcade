// banrion/js/engine.js
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
// The computer opponent. Wraps Lozza (js/lozza.js, MIT) in a worker and turns
// UCI chatter into one call: Engine.think(fen, cb) -> cb('e7e5').
//
// Three things here are not obvious:
//
// 1. THE WORKER IS BUILT FROM A BLOB, NOT A FILE. Chrome treats every file:
//    URL as a unique origin, so `new Worker('js/lozza.js')` off disk throws
//    "cannot be accessed from origin 'null'" -- the same rule that forced the
//    single-file bundle in the first place. A blob URL built from an inlined
//    copy of the source works from file: with no flags. Measured, not assumed.
//    Served (the modular tree), the sibling file is used instead.
//
// 2. WEAKNESS COMES FROM CHOOSING, NOT FROM SHALLOW SEARCH. The obvious way to
//    make an engine easy is to cut the depth, and it plays horribly: a
//    depth-2 engine hangs a queen outright and then finds a brilliancy, which
//    feels arbitrary rather than beatable. Instead the easy levels RANK the
//    root moves and then pick from those within a centipawn window of the
//    best. A weak level plays a move that is merely second- or third-best,
//    which is what a weaker human does.
//
//    Note on how the ranking is obtained: Lozza's `MultiPV` looks like the
//    tool for this and is not. Its multiPVMoves array is a log of every move
//    that was ever the best during iterative deepening, so it typically
//    reports one or two entries whatever you set MultiPV to, with scores from
//    different iterations. Measured, on a mid-game position, it offered a
//    single candidate. So ranking is done by searching each child position
//    directly and negating -- the caller supplies the child FENs, which keeps
//    this file free of any chess knowledge.
//
// 3. LOZZA HAS NO `stop` COMMAND (its README says so). So a search cannot be
//    called off -- it can only be ignored. Every think() carries a generation
//    number and a bestmove from a stale generation is dropped on the floor.
//    Where the engine must actually be silenced (new game, resign) the worker
//    is terminated and a fresh one spawned; that is cheap because Lozza is
//    plain JS with no WASM to compile.
//
// Depends on globals: none. The shell wires it to Game.

(function (global) {
  'use strict';

  const SRC_ID = 'lozza-src';       // inlined engine source in the bundled build
  const SIBLING = 'js/lozza.js';    // modular tree, served over http
  const BOOT_TIMEOUT_MS = 8000;

  // depth   how deep the search goes
  // movetime  wall-clock ceiling, so a slow machine cannot stall the game
  // multipv how many root moves to ask for
  // window  centipawns below the best move that a candidate may be and still
  //         get picked. This is the difficulty dial that matters.
  // depth/movetime  the search that produces the played move
  // rank            depth used to score every legal move; 0 = don't rank,
  //                 just play the best move the search found
  // window          centipawns below the best that a ranked move may be and
  //                 still get picked. This is the difficulty dial.
  const LEVELS = {
    beginner: { label: 'BEGINNER', depth: 4,  movetime: 700,  rank: 2, window: 220 },
    casual:   { label: 'CASUAL',   depth: 6,  movetime: 1200, rank: 3, window: 90  },
    club:     { label: 'CLUB',     depth: 9,  movetime: 2500, rank: 4, window: 25  },
    strong:   { label: 'STRONG',   depth: 14, movetime: 5000, rank: 0, window: 0   }
  };

  const MATE = 30000;

  const Engine = {
    LEVELS,
    level: 'casual',
    ready: false,
    thinking: false,
    name: '',
    worker: null,
    log: function () {},

    _gen: 0,
    _cands: null,
    _cb: null,
    _bootCb: null,

    // Can a worker be created at all in this context? A page opened off disk
    // without an inlined copy cannot, and the UI should say so rather than
    // offering a button that throws.
    available() {
      if (typeof Worker !== 'function') return false;
      if (this._source()) return true;
      return global.location ? global.location.protocol !== 'file:' : false;
    },

    _source() {
      const el = global.document && document.getElementById(SRC_ID);
      const src = el && el.textContent;
      return src && src.length > 1000 ? src : null;
    },

    // Resolves true once the engine has answered `uci`. Safe to call twice.
    start(opts) {
      if (opts && opts.log) this.log = opts.log;
      if (this.ready) return Promise.resolve(true);
      return new Promise(resolve => {
        let settled = false;
        const done = ok => { if (!settled) { settled = true; resolve(ok); } };
        try {
          this._spawn();
        } catch (e) {
          this.log('Engine unavailable: ' + e.message);
          return done(false);
        }
        this._bootCb = () => done(true);
        // A worker that never answers must not leave the UI waiting forever --
        // the same failure shape as the transport's stalled dial.
        setTimeout(() => {
          if (!this.ready) { this.log('Engine did not answer in time.'); done(false); }
        }, BOOT_TIMEOUT_MS);
        this.worker.postMessage('uci');
      });
    },

    _spawn() {
      const src = this._source();
      if (src) {
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        URL.revokeObjectURL(url);       // the worker holds its own reference
      } else {
        this.worker = new Worker(SIBLING);
      }
      this.worker.onmessage = e => this._line(String(e.data));
      this.worker.onerror = e => this.log('Engine error: ' + (e.message || 'unknown'));
    },

    // Kill and replace. The only way to silence a search Lozza will not stop.
    restart() {
      this._gen++;
      this.thinking = false;
      this.ready = false;
      this._cb = null;
      if (this.worker) { try { this.worker.terminate(); } catch (_) {} }
      this.worker = null;
      return this.start();
    },

    // New game: cheap when idle, a respawn when a search is in flight.
    newGame() {
      if (this.thinking) return this.restart();
      this._gen++;
      if (this.worker) this.worker.postMessage('ucinewgame');
      return Promise.resolve(this.ready);
    },

    // Discard whatever comes back, without touching the worker.
    cancel() { this._gen++; this.thinking = false; this._cb = null; },

    dispose() {
      this.cancel();
      if (this.worker) { try { this.worker.terminate(); } catch (_) {} }
      this.worker = null; this.ready = false;
    },

    setLevel(key) { if (LEVELS[key]) this.level = key; return this.level; },

    // think(fen, cb) -- play the best move found.
    // think(fen, candidates, cb) -- candidates is [{uci, fen}] for every legal
    // move; on a ranking level they get scored and one is chosen from the
    // window. Passing them is optional: without them every level plays best.
    think(fen, candidates, cb) {
      if (typeof candidates === 'function') { cb = candidates; candidates = null; }
      if (!this.ready || !this.worker) { cb(null); return; }
      const L = LEVELS[this.level] || LEVELS.casual;
      this.thinking = true;

      if (L.rank && candidates && candidates.length > 1) {
        const gen = ++this._gen;
        this._rank(candidates, L.rank, gen, ranked => {
          if (gen !== this._gen) return;              // superseded
          this.thinking = false;
          if (!ranked || !ranked.length) return this._plain(fen, L, cb);
          const top = ranked[0].score;
          if (top >= MATE - 100) return cb(ranked[0].uci);   // never miss a mate
          const ok = ranked.filter(m => m.score >= top - L.window);
          cb(ok[Math.floor(Math.random() * ok.length)].uci);
        });
        return;
      }
      this._plain(fen, L, cb);
    },

    _plain(fen, L, cb) {
      const gen = ++this._gen;
      this._cands = {};
      this._cb = cb;
      this.thinking = true;
      this._searchGen = gen;
      this.worker.postMessage('position fen ' + fen);
      this.worker.postMessage('go depth ' + L.depth + ' movetime ' + L.movetime);
    },

    // Score every candidate by searching the position it leads to and negating:
    // the child is scored from the opponent's point of view. Sequential, because
    // one worker is one engine -- and cheap, because rank depth is small.
    _rank(list, depth, gen, done) {
      const out = [];
      let i = 0;
      const next = () => {
        if (gen !== this._gen) return done(null);      // superseded mid-scan
        if (i >= list.length) {
          out.sort((a, b) => b.score - a.score);
          return done(out);
        }
        const c = list[i++];
        this._score(c.fen, depth, sc => {
          if (sc !== null) out.push({ uci: c.uci, score: -sc });
          next();
        });
      };
      next();
    },

    // One fixed-depth search, resolved with the score of the final iteration.
    _score(fen, depth, cb) {
      const w = this.worker;
      let best = null;
      const prev = this._raw;
      this._raw = s => {
        if (s.startsWith('info')) {
          const t = s.split(/\s+/);
          for (let i = 1; i < t.length; i++) {
            if (t[i] === 'cp') best = +t[i + 1] || 0;
            else if (t[i] === 'mate') { const n = +t[i + 1] || 0; best = n > 0 ? MATE - n : -MATE - n; }
          }
        } else if (s.startsWith('bestmove')) {
          this._raw = prev;
          cb(best);
        }
      };
      w.postMessage('position fen ' + fen);
      w.postMessage('go depth ' + depth);
    },

    // ---------------------------------------------------------------- UCI in
    _line(s) {
      if (this._raw) { this._raw(s); return; }
      if (s.startsWith('id name')) { this.name = s.slice(8).trim(); return; }
      if (s === 'uciok' || s.startsWith('uciok')) {
        this.ready = true;
        // Lozza wants a ucinewgame before its first search -- without it a `go`
        // is simply never answered, no error, no bestmove. Sending it here
        // means think() works on a freshly booted worker rather than only
        // after the shell happens to have started a game.
        this.worker.postMessage('ucinewgame');
        this.log('Engine ready: ' + (this.name || 'Lozza'));
        if (this._bootCb) { const f = this._bootCb; this._bootCb = null; f(); }
        return;
      }
      if (s.startsWith('info ')) { this._info(s); return; }
      if (s.startsWith('bestmove')) {
        const best = (s.split(/\s+/)[1] || '').trim();
        const cb = this._cb;
        const stale = this._searchGen !== this._gen;
        this.thinking = false;
        this._cb = null;
        // A result from a superseded search is not an error and not a move.
        if (stale || !cb) return;
        cb(this._choose(best));
      }
    },

    // info depth D ... multipv K ... score cp X ... pv m1 m2 ...
    _info(s) {
      const t = s.split(/\s+/);
      let depth = 0, pv = null, score = null, mpv = 1;
      for (let i = 1; i < t.length; i++) {
        if (t[i] === 'depth') depth = +t[i + 1] || 0;
        else if (t[i] === 'multipv') mpv = +t[i + 1] || 1;
        else if (t[i] === 'cp') score = +t[i + 1] || 0;
        else if (t[i] === 'mate') { const n = +t[i + 1] || 0; score = n > 0 ? MATE - n : -MATE - n; }
        else if (t[i] === 'pv') { pv = t[i + 1]; break; }
      }
      if (!pv || score === null || !this._cands) return;
      // Keep only the deepest completed iteration; earlier ones are noise.
      if (depth > (this._cands.depth || 0)) this._cands = { depth, byPv: {} };
      if (depth === this._cands.depth) this._cands.byPv[mpv] = { move: pv, score };
    },

    // Pick among the root moves the search reported. Anything within the
    // level's window of the best is fair game; the level IS this window.
    _choose(best) {
      const c = this._cands;
      if (!c || !c.byPv) return best;
      const list = Object.keys(c.byPv).map(k => c.byPv[k]);
      if (list.length < 2) return best;
      const L = LEVELS[this.level] || LEVELS.casual;
      if (!L.window) return best;
      const top = Math.max.apply(null, list.map(m => m.score));
      // Never throw away a forced mate to look human.
      if (top >= MATE - 100) return best;
      const ok = list.filter(m => m.score >= top - L.window);
      if (!ok.length) return best;
      return ok[Math.floor(Math.random() * ok.length)].move;
    }
  };

  global.Engine = Engine;
})(window);

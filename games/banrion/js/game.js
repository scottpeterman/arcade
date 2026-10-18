// banrion/js/game.js
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
// Game state and rules. Wraps chess.js and owns the one piece of protocol
// logic worth stating plainly:
//
//   THE SNAPSHOT IS THE WHOLE MOVE LIST.
//
// Not a position, not a delta. A move list replayed from the start position
// through chess.js is idempotent, self-validating, and complete, which buys
// reconnect-for-free and total validation in one move. A modified client
// cannot assert a position -- it can only offer moves, and every ply gets
// re-checked against the rules on the far side.
//
// Depends on globals: Chess (js/chess.js).

(function (global) {
  'use strict';

  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const Game = {
    chess: new Chess(),

    // 'local' (hot-seat) | 'online' (a peer) | 'cpu' (an engine)
    // cpu gates input exactly like online -- you own one colour -- it just has
    // no peer and nothing to publish. That is the whole reason a third mode is
    // cheap: the ownership rule already existed.
    mode: 'local',
    myColor: 'w',         // which side this client may move in online/cpu mode
    result: null,         // null | 'resign-w' | 'resign-b'

    _changeCb: () => {},
    onChange(fn) { this._changeCb = fn; return this; },

    // ------------------------------------------------------------
    // queries
    // ------------------------------------------------------------
    history() { return this.chess.history(); },
    fen() { return this.chess.fen(); },
    turn() { return this.chess.turn(); },
    board() { return this.chess.board(); },

    // Whose input the UI should accept right now. In local hot-seat both
    // colours are driven from one keyboard, so the only gate is whose turn it
    // is; online adds the ownership check.
    canMove() {
      if (this.isOver()) return false;
      if (this.mode === 'local') return true;
      return this.chess.turn() === this.myColor;   // online and cpu alike
    },

    isOver() {
      return this.result !== null || this.chess.isGameOver();
    },

    // Human-readable status for the UI.
    statusText() {
      if (this.result === 'resign-w') return 'WHITE RESIGNS - BLACK WINS';
      if (this.result === 'resign-b') return 'BLACK RESIGNS - WHITE WINS';
      const c = this.chess;
      if (c.isCheckmate()) {
        return c.turn() === 'w' ? 'CHECKMATE - BLACK WINS' : 'CHECKMATE - WHITE WINS';
      }
      if (c.isStalemate()) return 'STALEMATE - DRAW';
      if (c.isThreefoldRepetition()) return 'THREEFOLD REPETITION - DRAW';
      if (c.isInsufficientMaterial()) return 'INSUFFICIENT MATERIAL - DRAW';
      if (c.isDraw()) return 'FIFTY-MOVE RULE - DRAW';
      const side = c.turn() === 'w' ? 'WHITE' : 'BLACK';
      return c.inCheck() ? side + ' TO MOVE - CHECK' : side + ' TO MOVE';
    },

    // Legal destination squares from `square`, for move highlighting.
    movesFrom(square) {
      return this.chess.moves({ square, verbose: true });
    },

    // Does a move from->to need a promotion choice? Asked before the move is
    // attempted, so the UI can put up a picker instead of silently queening.
    needsPromotion(from, to) {
      return this.chess.moves({ square: from, verbose: true })
        .some(m => m.to === to && m.promotion);
    },

    // ------------------------------------------------------------
    // local move
    // ------------------------------------------------------------
    // Returns the move object, or null if illegal / not this client's turn.
    move(from, to, promotion) {
      if (!this.canMove()) return null;
      let m = null;
      try {
        m = this.chess.move({ from, to, promotion: promotion || 'q' });
      } catch (_) {
        return null;                       // chess.js throws on illegal input
      }
      if (!m) return null;
      this._changeCb('move');
      return m;
    },

    // The engine's move. Bypasses the ownership gate -- it is playing the side
    // the human does not own -- but NOT the rules: chess.js validates it like
    // any other move, so a confused engine cannot corrupt the board. Takes the
    // UCI long-algebraic form the engine speaks ('e7e8q'), which is the only
    // place in this codebase that notation appears; everything else is SAN.
    engineMove(uci) {
      if (this.mode !== 'cpu' || this.isOver()) return null;
      if (typeof uci !== 'string' || uci.length < 4) return null;
      if (this.chess.turn() === this.myColor) return null;   // not its turn
      let m = null;
      try {
        m = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4),
                              promotion: uci.length > 4 ? uci[4] : 'q' });
      } catch (_) { return null; }
      if (!m) return null;
      this._changeCb('move');
      return m;
    },

    // Every legal move for the side to move, as UCI plus the position it
    // leads to. The engine's easy levels rank these; nothing else uses it.
    // Built on a scratch board so the real one is never touched.
    candidates() {
      const scratch = new Chess(this.chess.fen());
      const out = [];
      for (const m of scratch.moves({ verbose: true })) {
        scratch.move(m);
        out.push({ uci: m.from + m.to + (m.promotion || ''), fen: scratch.fen() });
        scratch.undo();
      }
      return out;
    },

    resign(color) {
      if (this.isOver()) return false;
      this.result = 'resign-' + color;
      this._changeCb('resign');
      return true;
    },

    reset(opts) {
      this.chess = new Chess(START);
      this.result = null;
      if (opts && opts.myColor) this.myColor = opts.myColor;
      this._changeCb('reset');
    },

    // ------------------------------------------------------------
    // remote adoption
    // ------------------------------------------------------------
    // Turns alternate strictly, so a peer's snapshot is normally ours plus one
    // move. Anything else is a bug or a tampered client, and we say so rather
    // than clobbering a good board with a bad one.
    //
    // Returns { ok, reason, applied }.
    adopt(snapshot) {
      if (!snapshot || snapshot.type !== 'game') {
        return { ok: false, reason: 'not-a-game-snapshot', applied: 0 };
      }
      const remote = Array.isArray(snapshot.history) ? snapshot.history : null;
      if (!remote) return { ok: false, reason: 'no-history', applied: 0 };

      const mine = this.chess.history();

      // Our history must be a prefix of theirs. If it diverges, the two boards
      // are describing different games and replaying theirs would silently
      // discard ours.
      for (let i = 0; i < mine.length; i++) {
        if (i >= remote.length || remote[i] !== mine[i]) {
          return { ok: false, reason: 'divergent', applied: 0 };
        }
      }

      // Same length: nothing new. This is the common case -- our own move
      // echoed back through their snapshot.
      if (remote.length === mine.length) {
        const r = this._adoptResult(snapshot);
        return { ok: true, reason: r ? 'result-only' : 'up-to-date', applied: 0 };
      }

      // Replay from scratch and validate every ply. Cheap: a 100-move game
      // replays in well under a millisecond, and it means a peer cannot slip
      // an illegal position past us by asserting one.
      const fresh = new Chess(START);
      for (const san of remote) {
        let m = null;
        try { m = fresh.move(san); } catch (_) { m = null; }
        if (!m) return { ok: false, reason: 'illegal-move:' + san, applied: 0 };
      }

      this.chess = fresh;
      this._adoptResult(snapshot);
      this._changeCb('adopt');
      return { ok: true, reason: 'adopted', applied: remote.length - mine.length };
    },

    _adoptResult(snapshot) {
      const r = snapshot.result;
      if (r === 'resign-w' || r === 'resign-b') {
        if (this.result !== r) { this.result = r; this._changeCb('resign'); return true; }
      }
      return false;
    },

    // What goes on the wire. Deliberately small: the move list IS the game.
    snapshot() {
      return {
        type: 'game',
        v: 1,
        history: this.chess.history(),
        result: this.result
      };
    }
  };

  global.Game = Game;
  global.CHESS_START = START;
})(window);

<!-- banrion/engine.md -->

# The computer opponent

Lozza in a worker, wrapped so the rest of the game sees one call:

```js
Engine.think(fen, candidates, uci => { ... })
```

Player-facing behaviour is in the [README](README.md); the networking layer is
in [transport.md](transport.md) and the renderer in [render3d.md](render3d.md).
None of them is involved here. A computer game never opens a broker connection.

---

## Why a third mode was nearly free

`Game.mode` was already `'local' | 'online'`, and `canMove()` already gated
input by colour for online play. A CPU game is **an online game with no peer**:
same ownership rule, nothing to publish. So `'cpu'` added one branch and one
method, `engineMove(uci)`, which bypasses the ownership gate — it plays the
side you do not own — but not the rules. chess.js validates it like any other
move, so a confused engine cannot corrupt the board.

`engineMove` is also the only place in this codebase where UCI long-algebraic
notation appears. Everything else, including the wire protocol, is SAN.

---

## Loading: blob worker, not a file

`new Worker('js/lozza.js')` **throws when the page is opened off disk** —
"Script at 'file:///…' cannot be accessed from origin 'null'". This is the same
unique-origin rule that forced the single-file bundle in the first place.

What does work from a plain `file://` page, measured rather than assumed:

| | plain `file://` |
|---|---|
| `new Worker('sibling.js')` | blocked |
| `fetch()` a sibling file or a CDN | blocked |
| `new Worker(blobURL)` | **works** |
| `WebAssembly.instantiate(bytes)` already in the page | works |

So `bundle.py` inlines the engine into `<script id="lozza-src"
type="text/plain">` — inert text, not a script the page runs — and `engine.js`
turns it into a blob URL at spawn time. Served from a real web server, the
modular tree has no inlined copy and the sibling file is used instead. Both
paths are in `_spawn()`.

## Three Lozza-specific traps

**It needs `ucinewgame` before its first search.** Without it a `go` is simply
never answered: no error, no `bestmove`, nothing. `engine.js` sends it on
`uciok` so `think()` works on a freshly booted worker rather than only after
the shell happens to have started a game.

**It has no `stop` command** (its README says so). A search cannot be called
off, only ignored. Every `think()` carries a generation number, and a
`bestmove` from a superseded generation is dropped on the floor — routine, not
an error. Where the engine must genuinely be silenced, `restart()` terminates
and respawns, which is cheap because Lozza is plain JS with no WASM to compile.

**`MultiPV` is not a ranked root list.** It looks like the obvious way to build
a difficulty ladder and it is not: `multiPVMoves` is a log of every move that
was *ever* best during iterative deepening, so it usually reports one or two
entries whatever you set it to, with scores from different iterations. On a
mid-game position it offered exactly one candidate. Worse, on a repeat search
of the same position the transposition table answers immediately and it reports
almost nothing at all.

---

## Difficulty: choosing, not thinking less

The tempting knob is depth, and it plays badly. A depth-2 engine hangs a queen
outright and then finds a brilliancy; it feels arbitrary rather than beatable.

Instead the easy levels **rank the root and pick from a window**. The shell
hands `Engine.think` a `candidates` list — every legal move as `{uci, fen}`,
built by `Game.candidates()` on a scratch board — and `_rank()` scores each by
searching the position it leads to at a shallow depth and negating (the child
is scored from the opponent's point of view). Then any move within `window`
centipawns of the best is fair game, chosen at random.

Two deliberate details: a forced mate is never traded away to look human, and
`candidates` is optional — without it every level plays the best move it finds,
so the engine still works if a caller does not supply them.

| level | search | rank depth | window | measured cp given away |
|---|---|---|---|---|
| BEGINNER | depth 4, 700 ms | 2 | 220 | 83 |
| CASUAL | depth 6, 1200 ms | 3 | 90 | 38 |
| CLUB | depth 9, 2500 ms | 4 | 25 | 18 |
| STRONG | depth 14, 5000 ms | — | — | 0 |

The last column is the mean centipawn loss against a depth-6 reference ranking
over three positions, six samples each. It is a sanity check that the ladder is
monotonic, not an Elo claim.

Ranking costs about 60 ms a move at BEGINNER on a desktop — it is a shallow
search of ~30 child positions, and the level's own `movetime` dwarfs it.

---

## Licence

Lozza is by Colin Jenkins, **MIT** — see `LOZZA-LICENSE.txt`. Vendored verbatim
as `js/lozza.js` from `github.com/op12no2/lozza`; re-vendor by copying
`lozza.js` from the latest release, unmodified.

The MIT licence is the reason it is here rather than Stockfish. Stockfish is
stronger and has real `UCI_Elo` / `Skill Level` options, but it is GPL-3.0, and
inlining it into a single HTML file makes that file a combined work. Its
smallest useful WASM build also adds about 9.3 MB once base64'd, against 640 KB
for Lozza. Both were tried from `file://` and both work — the choice was
licence and weight, not capability.

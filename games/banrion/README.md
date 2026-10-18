<!-- banrion/README.md -->

# Banrion

**Banrion** — Irish for *queen*, from *ban* (woman) + *rí* (king). Pronounced
roughly BAN-ree-un.

A two-player internet chess game rendered as a glowing wireframe, with a
computer opponent for solo play. No server, no accounts, no build step. Two
people open the same HTML file, one hosts, the other pastes in a code, and they
play.

By Scott Peterman.

---

The splash holds for `SPLASH_MS` (4000) and can be tapped away after
`SPLASH_MIN_MS` (600). Both are at the top of the splash block in `chess.html`
— search for `SPLASH_MS`, which also finds it in the generated single file if
you want to try a value without rebuilding. The clock starts when the art is on
screen, not when the script runs, so the number is the time you actually see it.

---

## Running it

**`chess_single.html` is the one to open.** Double-click it, or serve it — both
work. It is entirely self-contained: chess rules engine, MQTT client, geometry,
renderers, all inlined. Nothing is fetched from a CDN and nothing is loaded from
disk beside it.

The only thing it needs from the network is an outbound WebSocket to a public
MQTT broker, and only for online play. Hot-seat works with no network at all.

> **Why a single file?** Chrome treats every `file:` URL as its own unique
> security origin, so a page opened off disk cannot load its own sibling
> `js/*.js`. Since "both players open it off their own disk" is a supported
> way to play, the shipping artifact has to be one file. See
> [Working on it](#working-on-it) for the editable tree.

---

## Playing

### Against the computer

**NEW GAME VS COMPUTER**, pick a side and a level. The engine loads on the
first computer game — a moment the first time, nothing after that — and the
game is entirely local: no broker, no game code, nothing published.

| | plays like |
|---|---|
| BEGINNER | gives away about two thirds of a pawn a move; beatable |
| CASUAL | solid, punishes real mistakes |
| CLUB | close to best play |
| STRONG | best move it can find, every time |

Levels are not "thinks for less time" — every level searches properly and the
easy ones choose a move that is merely second- or third-best. See
[engine.md](engine.md) for why that matters and how it is done.

### Hot-seat

**HOT-SEAT (THIS DEVICE)** starts a local game. Both colours are played from
the same keyboard. Useful for showing someone the board, and for testing
anything that isn't networking.

### Online

One player presses **HOST NEW GAME** and gets a code like `WFC-4L8QM235KYL8`.
The other pastes it into **JOIN GAME**. The board appears for both once the
opponent is actually present, not merely when the broker connection is up.

By default the host plays White; **HOST PLAYS: WHITE/BLACK** swaps that before
hosting. The joiner does not choose — it adopts whatever the host published, so
there is no handshake to get wrong.

> **The game code is also the encryption key.** Everything on the wire is
> AES-GCM encrypted with a key derived from that code, and the broker only ever
> relays ciphertext. Treat the code like a password, not a room number: anyone
> who has it can read and play the game. Read it over the phone, don't post it.

### Moving

Tap a piece, then tap a highlighted square. Legal destinations show as small
rings; captures show as a larger ring around the target. Promotion puts up a
picker rather than silently queening — underpromotion is a real move and you
will want it eventually.

**Drag to orbit. Wheel or pinch to zoom.** The canvas serves both orbiting and
selecting, so a "click" means the pointer went down and up in nearly the same
place. A small wobble still selects; a deliberate drag does not.

| Control | Does |
|---|---|
| **VIEW: 3D / 2D** | Swap renderers. The flat board is kept as a fallback and a reference implementation. |
| **FLIP BOARD** | Look from the other side. |
| **RESET VIEW** | Back to the default camera, keeping your side. |
| **RESIGN** | Ends the game; the result travels to your opponent. |

Each player's camera starts behind their own army.

### Disconnecting

Close the tab mid-game and reopen it, rejoin with the same code, and the board
comes back exactly as you left it — including whose turn it is and the whole
move list. There is no resync handshake; this falls out of how state is
represented. See [the transport doc](transport.md).

Your opponent dropping is not fatal either. The log says so, the position is
held, and they can rejoin.

---

## What's implemented

- Full chess rules — castling, en passant, promotion and underpromotion,
  check, checkmate, stalemate, threefold repetition, the fifty-move rule,
  insufficient material.
- Hot-seat and online play, with reconnect.
- 3D wireframe board with orbit camera, reflections, move animation, and
  selection highlighting; a 2D board behind a toggle.
- Resignation.
- A computer opponent at four levels, offline and local to your machine.
- A visuals panel: per-side piece colours from a fifteen-swatch list, glow,
  depth falloff, reflections, motes, and live density. See below.

**Not implemented:** clocks, draw offers, takebacks, and
PGN export — though the move list is the game's native state, so exporting it
is close to trivial.

---

## Working on it

The tree is plain files and globals. No frameworks, no bundler, no modules —
edit a file and refresh.

```
chess_single.html     ← the shipping artifact; generated, do not hand-edit
banrion.webp          ← splash art, inlined into the artifact as a data URI
chess.html            ← the real page: markup, styles, UI glue
bundle.py             ← inlines js/* into chess_single.html
js/
  chess.js            vendored chess.js v1.4.0 (rules engine)
  mqtt.min.js         vendored mqtt.js v5.15.2 (broker client)
  transport.js        encrypted broker link            → transport.md
  net.js              lobby, presence, snapshots       → transport.md
  game.js             game state and the adoption rule → transport.md
  pieces.js           piece geometry                   → render3d.md
  glrender.js         WebGL rasterisation backend      → render3d.md
  render3d.js         camera, scene, picking, draw     → render3d.md
  board2d.js          flat fallback board
  engine.js           computer opponent               → engine.md
  lozza.js            vendored Lozza (chess engine, MIT)
piece_lab.html        piece geometry workbench (see below); not part of the game
LICENSE               GPL-3.0
THIRD-PARTY-NOTICES.md  what is vendored, and under what
transport.md          networking and state model
render3d.md           the wireframe renderer
engine.md             the computer opponent
LOZZA-LICENSE.txt     Lozza's MIT licence
```

Develop against `chess.html` with any static server (Live Server, `python3 -m
http.server`) — the modular tree is far nicer to edit. Then:

```
python3 bundle.py     # rewrites chess_single.html from chess.html + js/*
```

Do not edit `chess_single.html` directly; the next bundle run overwrites it.

### Where things live

The two architecture documents cover the interesting parts and do not repeat
each other:

- **[transport.md](transport.md)** — the broker link, encryption, the
  lobby, and the state model that makes reconnect free.
- **[render3d.md](render3d.md)** — geometry, the camera, ray picking,
  and why the renderer is shaped the way it is.
- **[engine.md](engine.md)** — the computer opponent: loading a worker from a
  `file://` page, and how the difficulty ladder is built.

What isn't in either: the UI glue at the bottom of `chess.html`. It owns
selection state (`SEL`, `pickSquare`, `syncSelection`) so that the 3D view and
the 2D board render one model rather than each keeping their own. Both
renderers call `pickSquare(square)` and are handed state back; neither decides
anything.

### Visuals

**VISUALS** in the side panel is the piece lab's render controls, minus the
geometry editing. The lab is where a piece's *shape* is drawn; this is where
you set the table before a game.

- **WHITE / BLACK** pick a colour each, independently, from the same list.
  This recolours the pieces and nothing else — the grid, the motes and the
  highlight rings keep their own colours. The hint line warns when two picks
  are close in *both* hue and brightness, since the armies overlap heavily at
  board scale.
- **SAVE THIS VIEW** — first row of the VISUALS panel, and also next to RESET
  VIEW once a game is running. Keeps the camera you have orbited to as your
  default **for this browser**. It also prints the four numbers to the log:
  paste those into `TUNE.cam` in `js/render3d.js` and rebuild to change the
  view for everyone who opens the published copy, which a per-browser
  preference cannot do. Note that a `file://` or `content://` copy is an opaque
  origin where storage may be refused outright, and that a view saved on
  `127.0.0.1` is invisible to the hosted site — different origins, separate
  storage. What is stored is how far round you sit from *your own army*,
  not an absolute angle, so the same saved view puts you behind your pieces
  whether you are White or Black. RESET VIEW returns to it; CLEAR forgets it.
- **GLOW, FALLOFF, REFL**, and the **REFLECTIONS / MOTES** toggles are repaints
  and track the slider as you drag.
- **MERIDIANS / RING SEGS / KNIGHT** rebuild the meshes (and re-upload them on
  WebGL), so they apply when you let go, not during the drag. The per-piece
  density overrides scale with the global rather than pinning: the knight sits
  at roughly 45% of whatever the global is. It ships at 8 — turning density up
  fills the pieces in and they stop reading as wireframes.
- **KNIGHT** is how far the knight is turned from the file axis toward the
  opponent, in degrees. 0 gives you the full profile, aimed across the board at
  nobody; 90 points it dead ahead at your opponent and presents its edge to
  you, where a flat plate stops reading as a horse. It ships at 35 — turned
  enough to be facing the right way, flat enough to still be obviously a
  knight.

All of it is local — it is how *you* see the board, never published to your
opponent — and it is remembered between sessions where the browser allows it.
Opened straight off disk, Chrome treats the page as an opaque origin and may
refuse storage; the panel still works, it just forgets. **RESET** puts
everything back.

### Piece geometry

Pieces are tuned in `piece_lab.html` — a standalone workbench with live
profile editors, density sliders, an A/B benchmark and colour controls. It
ships in this repo for convenience but is **not part of the game**: nothing
in `js/` loads it, and the game runs without it.

Its EXPORT output is baked into `js/pieces.js` as data. **The game ships the
renderer, not the editor** — to change a piece, change it in the lab, EXPORT,
and paste.

---

## A note on the name and the wire

The game is Banrion; the **wire protocol is not renamed**. Game codes still
carry the `WFC-` prefix and the MQTT topics still live under the `wfchess-lab`
namespace, because those two strings are part of a game's identity: the topic
slug and the encryption key are derived from the code, so changing either means
a client of this build cannot join a game hosted by any older one, and a code
written down yesterday stops working.

They are one-line changes in `js/net.js` (`CODE_PREFIX`) and the `configure`
call beside it, worth making at a moment when nothing is mid-game.

---

## Credits and licences

Banrion is **GPL-3.0-or-later** — see `LICENSE`. Copyright Scott Peterman.

The vendored components are all permissive and GPL-compatible, and keep their
own terms; the combined work is GPL. Full table in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

- [chess.js](https://github.com/jhlywa/chess.js) — Jeff Hlywa, BSD-2-Clause.
  Vendored and wrapped; see the header of `js/chess.js`.
- [MQTT.js](https://github.com/mqttjs/MQTT.js) — MIT. Vendored unmodified.
- [Lozza](https://github.com/op12no2/lozza) — Colin Jenkins, MIT. Vendored
  unmodified as `js/lozza.js`; licence in `LOZZA-LICENSE.txt`.
- Public brokers (EMQX, HiveMQ, Mosquitto) are best-effort and unauthenticated.
  See [the threat model](transport.md#threat-model-honestly) for what that
  does and doesn't protect.

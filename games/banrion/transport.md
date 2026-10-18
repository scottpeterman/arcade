<!-- banrion/transport.md -->

# Transport and state

How two browsers stay in sync with no server, and why reconnecting costs
nothing.

Covers `js/transport.js`, `js/net.js`, and `js/game.js`. For the renderer see
[render3d.md](render3d.md).

---

## The decision everything else follows from

**The snapshot is the whole move list.** Not a position, not a delta.

```json
{
  "type":    "game",
  "v":       1,
  "history": ["e4", "e5", "Nf3"],
  "result":  null,
  "white":   "a"
}
```

That is the entire wire format. It is published *retained*, so the broker holds
the latest one and hands it to anybody who subscribes.

| Field | |
|---|---|
| `history` | SAN move list from the start position. The game. |
| `result` | `null`, `"resign-w"` or `"resign-b"`. Outcomes the move list can't express; checkmate and draws are derived. |
| `white` | Which role plays White, `"a"` (host) or `"b"` (joiner). **Host-only** — the joiner omits it and adopts the host's. |
| `v` | Format version. Nothing reads it yet; it exists so something can. |

A move list replayed from the start position through a rules engine is
**idempotent** (applying it twice gives the same board), **self-validating**
(every ply is re-checked against the rules), and **complete** (it is the whole
game, not a step in it). Those three properties buy, in one stroke:

- **Reconnect is free.** A client that has just subscribed and a client that
  has been connected all along run the identical code path. There is no resync
  handshake, no "catch me up" message, no partial state to reconcile.
- **Validation is total.** A modified client cannot assert a position. It can
  only offer moves, and every move is re-verified on the far side.
- **No sequencing.** No sid, no seq numbers, no dedup, no gap detection —
  because there is nothing to apply *in order*. There is only a value to adopt.
- **Threefold repetition and PGN come for free**, since the history is already
  there.

Cost: about 600 bytes for a 100-move game, and well under a millisecond to
replay. Nothing worth optimising.

### What this replaced

The predecessor to this code (a Star Fleet Battles game sharing the same
transport) needs a second, non-retained channel for deltas, with sequence
numbers and duplicate rejection. It needs that because its engine *applies*
events as state transitions — `receiveMove()` shifts a movement queue, so
applying the same event twice desyncs both boards.

Chess has no such state. `transport.js` still carries `sendEvent()` and its
sequencing so one file serves both games, but **the chess build never calls
it.** If you find yourself reaching for it here, something has gone wrong with
the state model.

---

## Layers

```
game.js       rules, turn ownership, the adoption rule    (no network, no DOM)
   ↑
net.js        lobby, presence, when to publish            (DOM: lobby + log)
   ↑
transport.js  encrypted pub/sub over MQTT, broker failover (no game knowledge)
   ↑
mqtt.js       vendored client
```

Each layer is ignorant of the one above it. `transport.js` has no idea it is
carrying chess; `game.js` has no idea a network exists.

---

## transport.js

### Topics and secrecy

The game code is the shared secret. Two things are derived from it:

- **An AES-GCM key**, via PBKDF2 (150k iterations, SHA-256, salted with the
  namespace). Every payload is sealed with a fresh 12-byte IV. The broker
  relays ciphertext and nothing else.
- **A topic slug**, via SHA-256 of `"topic:" + salt + code`, truncated to 8
  bytes. Deliberately *not* the code itself, so the broker's topic tree never
  carries the shared secret.

```
{ns}/{slug}/a/state     host's retained snapshot
{ns}/{slug}/b/state     joiner's retained snapshot
{ns}/{slug}/a/up        host presence      (retained, "1"/"0")
{ns}/{slug}/b/up        joiner presence
{ns}/{slug}/{a,b}/evt   delta channel — unused by chess
```

Each side publishes to its own topic and subscribes to the other's. Roles are
fixed at connect time: host is `a`, joiner is `b`.

`Transport.configure({ns, salt, clientPrefix})` parameterises the namespace, so
the same file serves multiple games without their codes ever colliding on a
shared broker. Chess uses `wfchess-lab`.

### Presence

Presence is a retained message plus an MQTT **will**: if a client drops without
saying goodbye, the broker publishes `0` on its behalf. Because it is retained,
a late joiner learns the host is up the instant it subscribes — which is what
makes joining feel immediate rather than polled.

Consequence worth remembering: **`onPeerStatus('online')` can fire more than
once** — on reconnect, or on broker replay. `net.js` only does the board reveal
on the first edge, and treats later ones as "opponent is back", re-publishing
its snapshot in case theirs is stale.

### Dialling and failover

`BROKERS` is an ordered list, walked on failure. Every dial is bounded by a
**6-second wall-clock timer**, and every failure path — timeout, socket error,
premature close, subscribe error — routes through a single `fail()`.

This matters more than it looks. mqtt.js's own `connectTimeout` only bounds
waiting for CONNACK *after the socket is open*; it does not bound establishing
the socket. A stalled TLS handshake — a dead public broker, a firewall dropping
the connection — emits neither `connect` nor `error`, so a promise that only
settles in those two handlers hangs forever, showing the user nothing at all.
That was a real bug: press HOST, get no code, no error, no toast, indefinitely.

`reconnectPeriod` is `0` during the dial so mqtt.js cannot quietly re-dial a
dead host behind the broker walk, and is raised to 3000 once a broker answers.

Worst case is roughly 18 seconds to exhaust three brokers, with a line in the
lobby log per attempt.

---

## game.js

Owns the rules (via chess.js) and one piece of protocol logic.

### The adoption rule

Both sides publish to their own topic, so each receives the other's snapshot
and must decide whether to take it.

```
accept  iff  my history is a PREFIX of theirs  AND  theirs is longer
```

Turns alternate strictly, so in practice their snapshot is mine plus exactly
one move. Anything else means the two boards are describing different games,
and replaying theirs would silently discard mine. So:

| Case | Result |
|---|---|
| theirs is longer, mine is a prefix | replay from scratch, validating every ply |
| same length | no-op — this is my own move echoed back |
| diverges from mine | **rejected**, board untouched, `divergent` logged |
| contains an illegal move | **rejected**, board untouched |
| asserts a position with no history | **rejected** |

Rejection never clobbers. A bad snapshot leaves a good board alone and says so
in the log — the failure mode is a visible desync warning, not a corrupted
game.

### Turn ownership

`canMove()` gates input: in hot-seat, only whose turn it is; online, that plus
"is this my colour". Colour assignment travels in the host's snapshot as `white` (see the wire
format above) and only the joiner adopts it — the host is the one asserting it,
so there is nothing to negotiate.

---

## net.js

The lobby, and the decision of *when* to publish.

Structurally: hosting resolves as soon as the broker subscription is up, which
is **not** the same event as the opponent arriving. The host shows its code and
waits; the board is revealed only on peer presence. Getting these two confused
is what makes a lobby feel broken.

`pushGame()` is called after any local change and on peer arrival. It is
fire-and-forget: retained on the broker, so it doubles as the resume snapshot.
There is no separate "send me the state" path because there is no state to send
beyond what is already retained.

Element lookups go through `el(id)`, which logs loudly when an element is
missing rather than returning null. A silent `if (el)` guard once let a working
host session look completely dead — the code was generated and published, and
the panel just never showed it.

---

## The brokers are a list, not a cluster

`BROKERS` is three unrelated public servers. They share nothing: a retained
message published to emqx does not exist on hivemq. So **which broker a game
lives on is part of its identity**, and both sides walking the list
independently is a bug waiting for a slow day.

It duly happened. A phone hosted, reached emqx in 1435 ms, and published there.
Two minutes later a laptop's emqx dial timed out at 6001 ms, fell through to
hivemq, connected in 1700 ms, found nothing, and reported *"Nothing retained on
that code."* Perfectly true, on hivemq. The code was fine and the host was
sitting on a different server.

Two changes:

**The code carries the broker.** `WFC-` + one tag character + the 12-character
body. Only the **body** derives the key and the topic slug, so the tag is pure
routing metadata, the key keeps its 60 bits, and a 12-character code from
before this existed still works — it just has no hint and must try everywhere.
The tag can only be added once the host knows which broker it got, so the code
is finalised after connect, not before.

**A joiner walks the list looking for the GAME, not for a socket.** Connecting
successfully to a broker the host never used means nothing was found, so it
closes and tries the next one. `Transport.joinAt(code, index)` dials exactly one
broker and lets the caller decide; `host()` keeps the old walk, because a host
does not care where it lands.

The error messages now separate the three cases, which need different actions
from the person reading them: no broker reachable at all, nothing on any broker
(a bad code), or *the code says emqx and I cannot reach emqx*.

---

## Presence, and why a sleeping host is not a missing one

Each side publishes a **retained** `1` to `<base>/<role>/up` and registers a
will of `0` on the same topic. So a client that vanishes is announced by the
broker, and a late joiner learns the state of the other side the moment it
subscribes.

Two things about that are easy to get wrong, and both were, until a phone
hosted a game and its owner switched apps to read the code out of their email.

**Presence must be re-asserted on every connect, not the first one.** The will
payload replaces the retained `1` the instant the socket drops. mqtt.js fires
`connect` again after an auto-reconnect, so the fix is simply to let that path
re-publish — but the original code guarded the whole subscribe callback with
`if (settled) return`, which is true on every reconnect. The result was a
permanent ghost: the board worked locally, the peer showed "opponent away"
forever, and anybody joining later read the retained `0` and was told there was
no host.

**Joining gates on the game existing, not on the peer being awake.** The
retained snapshot is proof the code is real. A joiner that sees one sits down
at the board and waits, with the status reading OPPONENT AWAY; only a code with
*nothing* retained behind it is a bad code. The old rule — wait 8s for peer
presence, then declare the code wrong — turned "the host's phone is asleep"
into "you typed it wrong", which is both false and unfixable by the user.

**A backgrounded mobile tab is frozen, not idle.** Its timers do not run, so
mqtt.js is not retrying either; nothing happens until the OS thaws it. The
shell listens for `visibilitychange` and calls `Transport.wake()`, which
reconnects immediately if the link is down and re-asserts presence if it is up.

---

## Threat model, honestly

Two people who both have the code can play. That's the whole model.

**The security boundary is the code's entropy, not the KDF.** A code is 12
characters from a 32-symbol alphabet — 5 bits each, so **60 bits**. (The
alphabet divides 256 exactly, so drawing from `getRandomValues` introduces no
modulo bias.) The 150k PBKDF2 iterations raise the cost of each offline guess;
they do not add entropy. 60 bits is far past casual guessing and far short of
what you would choose to protect something valuable — appropriate for a game
between two people, and the reason the code is worth saying out loud rather
than posting.

What that buys:

- **A third party cannot forge a snapshot.** AES-GCM is authenticated, so
  without the key a tampered or fabricated payload fails the tag check and is
  dropped before the game layer sees it. Someone who can write to the broker
  can publish noise, not moves.
- **They cannot read one either.** The broker operator sees ciphertext,
  message sizes and timing. The topic slug is derived from the code but is not
  the code, so the topic tree carries no secret.
- **Move validation is symmetric.** Each side re-checks the other's moves
  against the rules, so a modified client cannot make an illegal move stick.

What it does not buy:

- A modified client **can** stall, resign, or disconnect. There is no referee
  and no way to prove anything to a third party. This is a game between two
  people who chose to play each other, not a rated service.
- Anyone who learns the code has full access — read, play, and impersonate.
  There is no revocation short of starting a new game.
- Public brokers are unauthenticated and best-effort. Point `BROKERS` at your
  own for anything beyond a private game.

---

## Extending it

**A computer opponent** slots in behind `Game.move()`. chess.js is a rules
engine and never picks a move, so this needs something else — Stockfish WASM in
a Web Worker for a real engine, or a model driven over an API. Either way the
mode is local: no transport involvement, and `Game.canMove()` grows a third
case.

**Clocks**, if they ever happen, should put an elapsed-ms field on each move in
the history and let each client compute the remaining time locally. Do not sync
clock values over a best-effort broker — that is a reliable way to get two
players disagreeing about who flagged.

**Draw offers and takebacks** need a second field in the snapshot, not a second
channel. Anything that is part of the game's state belongs in the retained
snapshot; if you find yourself adding a message type, check first whether it is
really state.

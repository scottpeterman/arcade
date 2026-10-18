<!-- banrion/render3d.md -->

# The wireframe renderer

How a chess set gets drawn as glowing wireframe on a 2D canvas, and how a tap
turns into a square.

Covers `js/pieces.js` and `js/render3d.js`. For networking and state see
[transport.md](transport.md).

---

## Why Canvas 2D

There is no WebGL here. Every piece is a bag of line segments, projected by
hand and stroked in batches. That sounds like the slow way round, and for
filled polygons it would be — but this is a wireframe, and a wireframe is
nothing *but* edges.

The thing that makes it viable: **segments are batched into one `Path2D` per
colour per depth band**, so a frame costs roughly 45 stroke calls whether there
are 900 segments on screen or 45,000. Draw-call count is flat; only the vertex
transform loop grows.

The full 32-piece opening position is about **37,000 segments**, plus
reflections. That is the interesting number, and it is the WebGL decision
point. Mid-game boards are much lighter — the worst case is move one.

> **Measuring this properly is harder than it looks.** Canvas 2D defers
> rasterisation, so timing your draw calls synchronously measures only how fast
> you *submitted* commands. An earlier version of this code reported 6–7ms per
> frame on a board that was visibly running at 3fps. Use `requestAnimationFrame`
> wall-clock deltas, and measure on the target device — headless and desktop
> both lie.

---

## pieces.js — geometry

### Two shapes of piece

**Five of the six are surfaces of revolution.** A profile is a list of
`[radius, height]` pairs; lathe it around Y. Meridians are copies of the
profile at N angles; latitude rings connect them at each profile point. Rook
crenellations, the queen's crown, the king's cross and the bishop's mitre slit
are non-lathe details in an `EXTRAS` table.

**The knight is not.** It took five failed attempts to work out why. A Staunton
knight is not an anatomical horse — it is a **flat plate with rounded edges**:

- the silhouette carries all of the shape, ears included;
- thickness comes from sweeping a quarter-round bevel from the mid-plane out to
  each flat face;
- the flat faces are then meshed with contour rings marching inward.

Approaches that failed, in case you are tempted: constant-width extruded slab
(reads as a pig snout), variable-width loft (aardvark — no jaw), three-rail
loft with a centre ridge (flat card), swept tube along a curved spine
(anatomically a horse, but not a chess knight).

The face mesh (`faceRings()`) is worth understanding before touching it. Each
vertex travels the same *fraction* of its own local half-width — found by
ray-casting across the shape — so rings stay evenly graded and the innermost
one settles near the medial axis instead of overshooting into a tangle. Two
traps handled there: the width field is smoothed rather than the points, and a
point-in-polygon probe catches reflex vertices, whose inward normal points into
open air and would otherwise drag a ring straight across the knight's throat.

### Density

`DENSITY` sets meridians, ring segments, and ring spacing globally.
`DENSITY_BY` holds per-piece overrides.

It ships at **8 meridians**, judged on screen rather than derived. Density is
not a legibility knob you turn up: past about 8 the meridians close the surface
in and a piece reads as a lit blob at board scale, which is the opposite of
what a wireframe is for. Fewer segments (5,864 a set instead of 7,634) is a
side effect, not the reason.

Three constants, doing three jobs. `DENSITY` is live, `BASE` is where RESET
goes, and `TUNED` is what the per-piece overrides were measured against — the
denominator of the ratio that scales them, never a target. The knight's
8-against-18 was "a plate needs a bit under half what a lathe needs", so at the
shipped global of 8 the override lands on 4. `setDensity({})` runs once at load
so the boot state is identical to dragging the slider there and back; without
it the knight would ship at a raw 8 and silently drop the first time the slider
was touched.

These numbers are **baked in as data**, exported from `piece_lab.html`.
Profiles stay there: the lab owns the shape of a piece, the game owns how many
lines it is drawn with. To change a piece, change it in the lab, EXPORT, and
paste. Do not hand-edit geometry in two places.

`Pieces.setDensity({meridians, ringSegs})` changes the global at runtime.
`BASE`/`BASE_BY` record the values the overrides were **tuned against** and are
never written, so an override scales instead of pinning: the knight's 8 is
"less than half the global", not an absolute, and at a global of 30 it becomes
13. `setDensity` deliberately does not rebuild — the caller decides when to pay
for six meshes and, on GL, a buffer re-upload.

### Visuals

`Render3D.setSide(colour, key)` recolours one army from `TUNE.swatches`, the
lab's fifteen-entry list. Both backends read `TUNE.color` fresh every frame, so
this is a repaint with no rebuild and no re-upload.

Two things this is careful about:

- **Pieces only.** The grid, the motes and the highlight colours are not part
  of a side pick. Recolouring White changes White.
- **Two independent controls, not a themed palette.** One pick per army.

### Which way the knight faces

Five of the six pieces are surfaces of revolution and have no facing. The
knight is a flat plate, and its silhouette is traced in an x/y plane with the
muzzle at +x — the natural frame to *draw* in and the wrong one to *stand on a
board*, because files run +x. Built straight from the tracing table it faces
sideways across the board.

`EXTRAS.knight` rotates the tracing frame about Y on the way out, by
`KNIGHT_YAW` degrees measured from the file axis. This happens at the single
point every knight vertex passes through, so the silhouette table never has to
know a board exists. White ends up facing +z toward Black, and the z-mirror
`setPosition` already applies to Black turns its knights back around — the two
armies face each other for free.

The angle is a **dial, not a constant**, because both ends cost something on a
flat plate: at 0 the piece is aimed at nobody, at 90 it is edge-on to the
player and no longer reads as a horse. It ships at 35. `Pieces.setKnightYaw`
changes it; `Render3D.setKnightYaw` changes it and rebuilds.

`Render3D.setDensity(patch)` and `setKnightYaw(deg)` are the expensive ones: it rebuilds through
`Pieces`, calls `gpu.reuploadPieces()` when GL is live, and re-flattens the
position. `reuploadPieces` deletes the old buffers first — `segBuffer`
allocates, and dropping the handles leaks a board's worth of geometry per
slider release. Both go through `Render3D._rebuild()`, so there is one path
from "the mesh changed" to "the GPU knows".

The panel that drives all of this lives in `chess.html`; see the README. It is
local state — how *you* see the board — and is never published to the opponent.

---

## render3d.js

### Coordinates

Files run `+x`, ranks run `+z`, the board sits on `y = 0`, one square is one
unit. `worldOf(square)` and `squareOfWorld(x, z)` are the only two places that
know this.

Black's pieces are mirrored in `z` when placed, so the knights face each other.

### Camera

Yaw, pitch, distance, and a target height — a standard orbit rig. Each player's
camera starts behind their own army (`faceSide()`), which is just yaw 0 or π.

> **One sign worth knowing about.** `_cache()` computes
> `this._sp = -Math.sin(pitch)`, and the minus is load-bearing. The transform
> this was lifted from maps *farther away* to *lower on screen* — an eye
> **below** the board looking up. In the piece lab that is invisible, because
> its default yaw is 0.62 and no axis is ever seen head-on. A chess board is
> looked at square-on down the rank axis, where it is glaring: the near army
> draws at the top of the screen and the two sides appear swapped.

### Yaw is derived, not stored

Each player sits behind their own army, so an absolute yaw is the wrong thing
to remember: replayed for the other colour it puts you behind your opponent's
back. `TUNE.cam.turn` is a standing rotation *away from your own side*, and
every framing goes through `faceSide()`, which sets
`yaw = (colour === 'b' ? PI : 0) + turn`.

`resetView()` snaps to the **nearest** side plus the turn rather than freezing
whatever mid-orbit yaw was current — otherwise it half-resets, fixing pitch and
distance while leaving you facing sideways.

So: edit `turn`, never `yaw`. Anything written to yaw is overwritten by the
next `faceSide()` or `resetView()`.

`captureView()` / `applyView()` / `clearView()` are the saved-view API behind
the panel's SAVE THIS VIEW. `applyView` writes into `TUNE.cam`, which is why
`SHIPPED_CAM` snapshots the originals at load — without it, "go back to the
default" has nothing to go back to.

### Picking is a ray

A tap is un-projected into a world-space ray and intersected with the `y = 0`
plane. Where it lands *is* the square.

The obvious alternative — project all 64 squares to screen and hit-test the
quads — is worse in two ways. It needs special cases for squares near the
horizon, where a quad degenerates or wraps behind the camera. And it creates a
second, independent screen↔world mapping that can drift out of agreement with
the one used for drawing.

That second failure is not hypothetical. The flat 2D board had exactly this
bug: its CSS box was not square, its backing store was, and the drawing got
stretched on one axis while the hit-test used unstretched cell sizes. Clicks
landed two files away from the piece you aimed at. **One inverse of the camera,
used by everything.**

`pickSquare()` is verified against `toCam()` on all 64 squares at several
camera angles — if the two ever disagree, that test fails.

### Zoom is per pixel, not per event

The wheel handler used to apply a flat 1.1x per event. A mouse notch is one
event of about 100px; a trackpad flick is a burst of twenty events of about
5px each. Reacting per event made the two differ by roughly 20x — the trackpad
gesture that should have zoomed 1.2x zoomed 6.7x, which reads as
uncontrollable rather than fast.

Zoom is now `exp(pixels * wheelGain)`, with `deltaMode` normalised (Firefox and
some mice report lines or pages, not pixels) and a per-event clamp so one
freakish delta cannot teleport the camera. A notch lands at 1.16x and a
twenty-step trackpad flick at 1.20x. `TUNE.cam.pinchGain` damps the touch
gesture the same way; 1.0 is the raw finger ratio.

### Drag versus click

One canvas serves both orbiting and selecting, so "click" has to mean something
more specific than pointerdown:

> pointer went down and up having travelled less than 6px.

A small wobble still selects. A deliberate drag orbits and selects nothing.
Both directions are worth testing, since getting it wrong in either is
maddening — either the board won't turn, or every attempt to turn it moves a
piece.

### The frame loop

Redraws are dirty-flagged, not continuous. Orbiting, zooming, a position change
or an animation set `_dirty`; otherwise the loop does nothing. On a static
position the renderer is idle.

**Buckets.** The scene is flattened into flat arrays per bucket — light pieces,
dark pieces, board grid, two reflections, highlights, and the animating piece —
then each is collected into screen-space paths per depth band and stroked.
Glow is three stacked strokes at decreasing width and increasing alpha under
`globalCompositeOperation = 'lighter'`. Reflections are the geometry mirrored
about `y = 0` at low alpha, using a separate low-detail mesh and the core
stroke only, which makes them roughly three times cheaper than the real thing.

**Animation.** Flattening 37,000 segments every frame to slide one piece would
be silly, so the static pieces are flattened once when the position changes and
the single moving piece is flattened per frame. It eases, and lifts slightly at
the midpoint so a move reads as a move rather than a teleport.

> `finishAnim()` is deliberately callable from outside the animation loop. It
> used to only run inside `requestAnimationFrame`, which is throttled in a
> background tab — so the "animation in progress" flag could stay set
> indefinitely and silently swallow every subsequent click. Now a click during
> a slide snaps the animation and then applies. **Never clear input-gating
> state only inside rAF.**

---

## Who owns what

The renderer owns none of the game. It is handed a position (`setPosition`),
selection and highlight state (`selected`, `targets`, `lastMove`), and it calls
back with a square (`onPick`). It never consults the rules, never decides
whether a move is legal, and never mutates game state.

That is what lets the flat 2D board coexist behind the VIEW toggle: both
renderers implement the same tiny contract and display one model owned by the
UI glue in `chess.html`. Keeping `board2d.js` around costs a few KB and is
worth it — when something looks wrong in 3D, being able to drop to a flat board
that cannot be wrong about geometry tells you immediately whether the problem
is the renderer or the game.

---

## If it needs to become WebGL

The port is smaller than it looks, because the hard parts are already separated
from the drawing:

- **Geometry is already flat segment arrays** — that is a vertex buffer with no
  restructuring at all.
- **Picking does not touch the renderer.** The ray/plane intersection needs the
  camera matrices and nothing else.
- **Depth bands and glow are the thing you would throw away**, replaced by real
  depth testing and a line shader.

What would need thought: the glow currently comes from stacked strokes, which
has a particular soft, additive look that a naive line shader will not
reproduce. Budget time for that specifically — it is most of the aesthetic.

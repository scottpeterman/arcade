# NORMANDY

First-person beach assault, Omaha · Dog Green, 6 June 1944. The ramp drops, you wade in, run hedgehog to hedgehog under a sweeping MG42, shelter at the seawall, go through the gap and grenade the casemate.

One self-contained HTML file, built from `game.html` plus assets.

## Engine

- **World:** DECKRUNNER's solid-hull software rasterizer: low-res z-buffer, perspective-correct mipped Freedoom textures, sun shading against a horizon-height shadow map. Fog goes to haze instead of black, and a cylinder sky sits behind it. The world is a triangulated heightfield beach (non-uniform grid, 2 m rows at the seawall), Czech hedgehogs built from three oriented beams, timber stakes, a bevel-top seawall with an exit gap, and a bevel-top casemate with a firing slit and rear door.
- **Soldiers:** 8-direction billboards from the sprite sheet, drawn into the same z-buffer. The parapet hides their legs.
- **HUD:** Bounty Hunter's frame, warmed to amber. LIFE and EXPO columns; SCORE · TIME · HEALTH · M1 (8-round en-bloc, pings on the last round) · NADES · KILLS · MAP. Phones in portrait get a thumb deck under the view.
- **Sound:** ZzFX core, as in DECKRUNNER.

## Rules that matter

- The MG42 bursts and pauses. With you in its arc and in sight, it tracks you with lag; otherwise it sweeps the beach. Its arc is ±60° about seaward.
- A crouched player behind a hedgehog is covered from the MG. Standing behind one is not.
- The seawall base is dead ground for the MG, and for the riflemen if you crouch.
- The casemate has a gunner and a loader, seen head and shoulders in the slit. Three ways in: a grenade through the slit (or the open rear door) destroys it; shooting both crew through the slit silences it (the loader takes the gun 3 s after the gunner falls); or walk round to the rear door, which opens as you reach it and brings both crew to the doorway to fight.
- Out of clips with the rifle empty, the bayonet goes on: fire becomes a lunge that takes the soldier in front of you within 2.4 m. The M1 slot reads BAY. Any ammo can puts you back on the rifle.
- First-aid packs give +50 health. Ammo cans give +3 clips (max 12) and +2 grenades (max 6); you only pick one up if you need it.
- Health regenerates once nothing has seen you for 3 seconds.

## Build

```
git clone --depth 1 https://github.com/freedoom/freedoom.git ../freedoom
python3 tools/slice_sprites.py src/1000011203.png build/soldier_blue --add down=src/down.png:150 --add fall=src/fall.png:150 --debug build/dbg_blue.png
python3 tools/build.py ../freedoom
```

This writes `dist/index.html` (full page) and `dist/artifact.html` (fragment). The build needs Pillow, numpy and scipy.

`slice_sprites.py` finds cells as connected components and assigns each one to the nearest row and column label, because the sheet is not on a fixed grid. It removes red spatter, then anchors each frame helmet-over-feet. The debug sheet shows every frame on its anchor.

## Test

```
python3 tools/shots.py build/shots 1280x800
python3 tools/shots.py build/shots_p 412x880
```

`window.__qa` exposes `play()`, `place(x, z, yaw, pitch, crouch)`, `advance(sec)`, `freeze(bool)`, `grenade()`, `fire()` and `state()`.

## Stages

Skip ahead for testing or practice. Later stages start with the ramp down; stage 3 and up set the seawall checkpoint.

| # | name | start |
|---|---|---|
| 0 | boat | in the LCVP, ramp up |
| 1 | beach | off the ramp in the shallows |
| 2 | mid | crouched behind a second-row hedgehog |
| 3 | seawall | crouched at the seawall base |
| 4 | gap | through the gap, riflemen to your left |
| 5 | bunker | beside the casemate |

Choose with `?stage=4` or `?stage=gap` (local file, GitHub Pages), `#stage4` or `#gap` (also works for the Claude artifact link), the 0–5 keys on the title screen, or by tapping the STAGE line on a phone.

## Controls

WASD move · mouse, Q/E or arrows look (mouse works without pointer lock: move to look, rest at the view's edge to keep turning) · click / Space fire · Alt or C crouch · G (or right-click) grenade · R reload · M sound · P pause · V post pass.
Touch: left thumb moves, right thumb looks; FIRE / NADE / DUCK.

## Credits

Textures: Freedoom (BSD). Sound synthesis: ZzFX by Frank Force (MIT).

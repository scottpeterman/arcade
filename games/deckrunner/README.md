# DECKRUNNER

A wireframe capital-ship assault game for the browser, in the tradition of the 1983 Atari *Star Wars* cabinet. Fly the deck of enemy warships at altitude zero, knock out their shield generators, silence the launch bays, then drop into the trench and put a volley into the reactor port. Pull up before the end wall.

Seven waves. Six capital ships, then the starbase. Break its core and freedom survives.

**Play:** https://scottpeterman.github.io/deckrunner/

Everything is one self-contained HTML file: no build step, no dependencies, no network calls beyond an optional Google Fonts request. It runs from `file://`, from GitHub Pages, and on phones in portrait or landscape.

<p align="center">
  <img src="docs/screenshots/gameplay-starbase-hub-slowmo.png" width="720" alt="Flying past the starbase hub at half speed with two plasma bolts incoming">
</p>

## The campaign

Each wave opens with a target briefing: hull dimensions, shield generators, launch bays, turret count, trench length, and how many fighters can be up at once.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/wave-01-corvette.png" width="240" alt="Wave 1 briefing: Corvette"><br><b>01 · Corvette</b><br>1300 m · 1 generator · no bays</td>
    <td align="center"><img src="docs/screenshots/wave-02-frigate.png" width="240" alt="Wave 2 briefing: Frigate"><br><b>02 · Frigate</b><br>1700 m · 2 generators · catwalks</td>
    <td align="center"><img src="docs/screenshots/wave-03-destroyer.png" width="240" alt="Wave 3 briefing: Destroyer"><br><b>03 · Destroyer</b><br>2100 m · first launch bay</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/wave-04-heavy-cruiser.png" width="240" alt="Wave 4 briefing: Heavy Cruiser"><br><b>04 · Heavy Cruiser</b><br>2500 m · gunship heavies</td>
    <td align="center"><img src="docs/screenshots/wave-05-battle-carrier.png" width="240" alt="Wave 5 briefing: Battle Carrier"><br><b>05 · Battle Carrier</b><br>2900 m · two hangars</td>
    <td align="center"><img src="docs/screenshots/wave-06-dreadnought.png" width="240" alt="Wave 6 briefing: Dreadnought"><br><b>06 · Dreadnought</b><br>3300 m · 4 generators · 32 turrets</td>
  </tr>
  <tr>
    <td align="center" colspan="3"><img src="docs/screenshots/wave-07-starbase.png" width="240" alt="Wave 7 briefing: Starbase"><br><b>07 · Starbase — final target</b><br>2400 m rotating disc · 3 spoke trenches · 3 ports, one core</td>
  </tr>
</table>

Ship names are drawn at random each run; the class, layout rules and difficulty for each wave are fixed.

### In the solid hull

The default build draws the hull as textured, sunlit geometry over a world backdrop: an ice world and an earthlike world below the early ships, and a ringed gas giant for the Dreadnought and the starbase. From the Heavy Cruiser up, sponson gun decks run down both sides below the main deck. Enemies are flat-shaded bodies with their red vector edges kept on top. V switches to the pure vector cabinet and B toggles the backdrop.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/wave-03-destroyer-orbit.png" width="380" alt="Wave 3: banking over the Destroyer's deck with the earthlike world below"><br><b>03 · Destroyer</b> · in orbit</td>
    <td align="center"><img src="docs/screenshots/wave-04-heavy-cruiser-sponsons.png" width="380" alt="Wave 4: the Heavy Cruiser's sponson deck and its turret battery"><br><b>04 · Heavy Cruiser</b> · sponson deck</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/wave-06-dreadnought-ringed-giant.png" width="380" alt="Wave 6: the Dreadnought's deck under a ringed gas giant and its moons"><br><b>06 · Dreadnought</b> · under the giant</td>
    <td align="center"><img src="docs/screenshots/wave-07-starbase-rim.png" width="380" alt="Wave 7: crossing the starbase rim toward the habitat ring"><br><b>07 · Starbase</b> · crossing the rim</td>
  </tr>
</table>

### The starbase

The last target is a 2.4 km disc that turns once every three minutes. Three radial trenches run from the rim to the hub, each ending in a reactor port, and all three ports feed one core. Two shield generators flank each spoke, so clearing the shields takes several passes. Each pass lines you up on the next spoke; the trench mouth is aligned as you cross the rim, then drifts as the station rotates under you, so you steer to stay in it all the way to the hub wall.

<p align="center">
  <img src="docs/screenshots/gameplay-starbase-core-approach.png" width="720" alt="Running a spoke trench toward the hub; reactor ports glow green while shielded">
</p>

## Controls

| Input | Action |
|---|---|
| Mouse | Aim and steer. The ship flies toward the reticle. |
| Left button / Space | Fire |
| Right button / Q | Switch guns: alternating pairs ↔ linked quad |
| Wheel / `[` `]` | Gun convergence range (150–700) |
| Triple-tap / E / middle button | Energy burst: wide cone ahead, clears plasma, recharges (kills speed it up) |
| WASD / arrows | Keyboard aim |
| `−` / `=` / `0` | Game speed slower / faster / reset (down to 0.05×) |
| P · M · G | Pause · sound · glow |
| V · R · B | Solid / vector hull · chunky / fine pixels · world backdrop |
| Touch | Drag to aim, hold to fire |

To break off a pass, hold the stick hard outboard past the hull edge: the ship banks away, runs back along the side of the hull and turns in at the bow for the next pass. Your guns stay live the whole way round, so you can rake the side and the sponson batteries on the run back. They shoot back, but only the guns in front of you: nothing fires into your back while you swing round. Push hard into the turn and hold it and the ship keeps banking, swinging straight back over the stretch of hull you just left. Clearing the stern does the same. The ship flies the turn; the stick only decides where it ends.

Below 22 altitude over the hull, everything scores double. Linked quad hits hardest when the target sits at your convergence range.

## Features

- **Solid hull (v9).** The ship is drawn as textured geometry: Freedoom plating on the decks, greebled tech walls down the trenches, grating underfoot, blast doors on the reactor wall, a recessed hangar bay, habitat windows round the starbase ring. A low side sun throws long shadows across the deck (a horizon-height shadow map, so blocks, towers and the spire all cast), and fighters drop shadows on whatever they fly over. It renders in a z-buffered software rasterizer at low resolution, scaled up chunky. Everything that is energy or enemy stays vector and is depth-tested against the hull, so superstructure hides what is behind it. **V** switches back to the pure vector cabinet (remembered), **R** toggles fine pixels, `?solid=0` starts in vector.

- **Procedural capital ships** built from a heightmap hull: superstructure, side trenches, towers, hangar blocks, and a main trench ending at the reactor wall. The starbase uses a separate polar-coordinate hull that rotates in real time.
- **Vector renderer** with depth-graded brightness, additive two-pass glow, and screen-space bloom on enemy plasma.
- **Four-gun convergence gunnery** with heat, two fire modes, and bolts that can intercept incoming fire.
- **Target damage readout** in the style of a ship systems display: every generator, bay, turret, tower and reactor port is a box that goes amber when hit and dark when destroyed.
- **Synthesized audio** (ZzFX core) through a mixer with a compressor, reverb send, stereo panning and distance falloff from each source's position, voice caps and pitch jitter.
- **Slow-motion control** for studying mechanics or taking screenshots. Audio pitches down slightly with it.
- **Portrait phone layout** that moves the instruments into the sky and keeps the deck clear.

<p align="center">
  <img src="docs/screenshots/gameplay-plasma-fire.png" width="420" alt="Incandescent enemy plasma bolts closing on the player">
  <img src="docs/screenshots/gameplay-phone-harrow.png" width="200" alt="Portrait phone layout with a Harrow fighter banking">
</p>

## Running locally

Open `index.html` in any current browser. Sound starts on the first click (LAUNCH), as browsers require.

For testing, `index.html?wave=N` starts the campaign at wave N (1–7). `?wave=7` goes straight to the starbase.

## Builds and feature switches

The top of the game script holds a `BUILD` version, a `CHANGELOG`, and `FEATURES` switches for balance options under test. The current build and live features are shown in the bottom-right corner (switched-off features are struck through), and the full changelog is under **BUILD** on the title card.

Any feature can be toggled from the URL for A/B play, and combined with `wave`:

```
index.html?wave=5&regen=0      wave 5 with shield regeneration off
index.html?burst=0&grow=0      no energy burst, flat 8 shields
```

## Project layout

```
index.html                     the game (single file)
docs/ENGINE.md                 reference design for building games in this style
docs/screenshots/              images used in these docs
tools/fighter_viewer.html      wireframe model viewer used to pick the enemy fighter design
tools/wave_start_audition.html sound audition page used to pick the wave-start sound
THIRD_PARTY_NOTICES.md         ZzFX license
```

## Building your own

[`docs/ENGINE.md`](docs/ENGINE.md) is a reference design for this engine: the camera and vector renderer, how hulls, models and collision are built, the combat and enemy systems, the progression ladder, the audio graph, how it was tested, and recipes for adding ship classes, hull types, enemies and sounds. It's written so you can use it to build a different game in the same style.

## Credits

Game design and direction: Scott Peterman. Built iteratively with Claude (Anthropic).

Sound synthesis core from [ZzFX](https://github.com/KilledByAPixel/ZzFX) by Frank Force, MIT License. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Inspired by Atari's *Star Wars* (1983). No assets, sounds or designs from that game are used.

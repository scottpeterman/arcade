# Tauri Reach

Prototype for a space fighter game set inside a nebula around a young, violently active star: a volumetric nebula you can fly through, a star that throws plasma through it, and two bandits to dogfight with kinetic guns. The star's interference hits everyone's sensors, yours and theirs.

![Orbit view with an eruption underway](docs/screenshots/orbit-eruption.png)

## Controls

| Input | Action |
|---|---|
| C or Tab | Switch between orbit camera and flying the fighter |
| V | Cockpit or chase view while flying (cockpit is the default) |
| H | Hide the controls card |
| F | Trigger an eruption now |
| 1 / 2 / 3 | Volume quality: low, medium, high |
| W / S | Throttle up / down. The ship always flies forward; the throttle sets cruise speed (34–95) |
| Arrows | Pitch and yaw |
| Mouse | Click to capture, then steer |
| Q / E | Roll |
| Shift | Boost |
| Space / left mouse | Guns |
| G / right mouse | Alternating pairs ↔ linked quad |
| Wheel / `[` `]` | Gun convergence (120–500) |
| T | Next target |
| M | Mute |
| , / . | Slow time down / speed it back up (1×, 0.5×, 0.25×, 0.1×) |
| Touch | Orbit: drag and pinch. Fly: left half drag steers, right half drag up/down is the throttle, Fire button shoots |

## Cockpit view

![Cockpit at speed through dust, target obscured](docs/screenshots/cockpit-cruise.png)

The cockpit HUD is drawn on a 2D canvas over the WebGL view:

- **Pitch ladder.** Space has no horizon, so the ladder is referenced to the star's equatorial plane. It rolls with the airframe.
- **Heading tape.** Bearing around the star's spin axis.
- **Side tapes.** Speed on the left, with a dust-density bar. Range to the star on the right.
- **Markers.**
  - A flight-path marker shows where the ship is actually going, not where the nose points.
  - The star and the bandits are marked on screen, and get edge arrows when off-screen.
  - Plasma threats are marked at the closest point on each live tendril.
  - Eruption warnings sit on the active region.
- **Target diamond.** Solid with a lock ring (its hit points) when the line of sight is clear. Dashed with the optical depth when dust blocks it, or `STATIC` when interference whites out the sensors.
- **Lead pip.** Where to put the boresight so a round meets the target. It turns red when it sits on the boresight inside gun range.
- **Guns.** Heat bar, mode and convergence under the boresight, and a hit marker around it.

Static from the ionized sheath jitters the symbology and makes it drop out, but the canopy frame stays still. Plasma contact and hits shake the eye point.

Near-field dust streaks sell speed and density from inside the volume. 700 motes wrap in a box around the camera, each drawn as a line stretched along velocity, with brightness set by local dust density. They warm in color inside a plasma sheath.

![Cockpit inside an ionized sheath](docs/screenshots/cockpit-sheath.png)

## Flight

The fighter never stops. The throttle sets a cruise speed between 34 and 95, and the engine holds it against the dust: dense dust still drags you below cruise, but never below 28. Shift boosts to 1.8× cruise. At the edge of the nebula the ship comes about on its own, turning harder the deeper you go, the way Deckrunner's ship swings round at the end of the hull.

Time scale slows the whole simulation (bandits, rounds, eruptions, shock fronts) while the stick and throttle stay at real-time rates, so you can fly a pass in slow motion and watch how it unfolds.

## Combat

![Cockpit: tracers converging on a crossing bandit, lead pip on the boresight](docs/screenshots/dogfight-cockpit.png)

**Guns.** Kinetic only, ported from Deckrunner. Four ports converge at the convergence range: alternating pairs fire fast, the linked quad fires all four at 1.5× damage, more slowly. Every shot adds heat; at 100 the guns lock until heat falls below 35. Rounds travel at 900 u/s for 0.8 s and inherit the ship's velocity. Hits are swept-segment tests from each round's previous position to its current one, so fast rounds can't tunnel through a fighter.

**Bandits.** Two at a time, respawning 5 s after a kill. The airframe is a space-going close-support brawler on the A-10 pattern: straight thick wings with drooped tips, twin engine pods carried high on the aft fuselage, twin tails, and a rotary cannon out of the nose. It is slower and tougher than the player (10 hit points), and fires 6–9 round bursts from the nose gun. Each one flies the same arcade model as the player: velocity follows the nose, and dust is drag. Its turn rate is limited and it rolls into its turns.

![Bandit, front quarter](docs/screenshots/bandit-front.png)
![Bandit from behind: the twin exhausts are what you see in a chase](docs/screenshots/bandit-rear.png)

- **Attack.** Lead pursuit on its own firing solution. It fires 4–6 round bursts when its nose is within about 7° of the solution and inside 430 units.
- **Extend.** After an overshoot or a close pass, it breaks off along a random heading for 2–3.5 s, then comes back around.
- It keeps clear of the star and stays inside the nebula.

**Interference cuts both ways.** Bandits run the same environment checks as the player: shock fronts shove them and drain their hit points, plasma and the jet core burn them, and a kill by the star is announced. Their own static scales their aim error from 0.6° to almost 10°, and above 0.8 they hold fire. They also need an optical depth under 1.3 along the line to you, so dense dust hides you. For the player, the lock (optical depth under 1.0, static under 0.45) gates the lead pip. The pip wanders as static climbs, and without a lock you fire down the boresight.

![56 units ahead of a shock front: sensor noise, lock still holding at τ 0.77](docs/screenshots/shock-dogfight.png)

![Chase view of the same pass](docs/screenshots/dogfight-chase.png)

**Tracers and effects.** Tracers and sparks are 1-pixel lines, too thin for the half-resolution volume to resolve their depth. They render into their own target with colors pre-dimmed by a CPU optical-depth march from the camera, and are added after the composite. So a burst fired into thick dust fades the way the dust says it should, and bloom still picks it up.

![A kill: debris, flash and sparks](docs/screenshots/splash.png)

**Sound.** Small WebAudio synthesis: guns, hits, rounds cracking past the canopy, explosions, and a static bed whose hiss and crackle follow the interference level.

## How it works

### One environment, read by both the renderer and the game

At startup the page bakes a 96³ density grid from warped fbm noise (about 0.6 s, sliced across frames so the page stays responsive). The grid is kept twice:

- a `Float32Array` on the CPU, which gameplay reads, and
- the same values uploaded as an RG8 `Data3DTexture`, which the volume shader raymarches. R is dust density, G is tint (red emission gas versus blue reflection dust).

Because both sides read the same field, what you see is what you get:

- **Drag.** The fighter's drag is the dust density at its position.
- **Line of sight.** The target lock integrates optical depth along the line to the target through the grid, using the same absorption constant as the shader. Dust you can see between you and the target breaks the lock. Bandits use the same march to decide whether they can see you.

### The volume

The nebula is not geometry. A full-screen pass at half resolution casts a ray per pixel, clips it to the nebula sphere and to the opaque scene's depth buffer, and steps along it, accumulating emission and absorption. Each step samples:

- **the density texture,** plus a small tileable detail texture for fine structure. The detail is cosmetic and gameplay ignores it.
- **one extra density sample toward the star,** a cheap self-shadow. Dust faces lit by the star get bright rims; dust behind other dust stays dark.
- **the tendril field,** described below.

A composite pass combines the result with the scene: `scene * transmittance + emission`. Bloom and ACES tone mapping follow.

### The star: eruptions, jets and a disk

The star's activity is modelled on what real young (T Tauri) stars do.

#### Coronal mass ejections

Each eruption runs through four phases:

1. **Warn (3.6 s).** An active region on the surface brightens and flickers. This is the telegraph. In fly mode, the HUD tells you if you are inside the cone the eruption will sweep.
2. **Rise (2.8 s).** A magnetic loop lifts off between two footpoints and arches outward.
3. **Erupt.** The loop becomes a flux rope and inflates while its legs stay anchored to the footpoints, giving the classic "lightbulb" CME shape. Between 1.6 and 3 s its legs reconnect and the rope detaches into a closed ring that keeps expanding outward. Ahead of it runs the **shock front**: a spherical cap centred on the eruption site that lights the dust as it sweeps through.
4. **Fade.** The rope and front dim as the ejection leaves the nebula.

![A CME inflating, with its shock front lighting the dust, and the bipolar jets](docs/screenshots/cme-orbit.png)

#### Bipolar jets and the accretion disk

- **Jets.** Two collimated jets run along the spin axis. Knots (Herbig-Haro knots) travel up them at 38 u/s, and each jet ends in a bow shock where it rams the cloud. The jets are thinner than a raymarch step, so the shader integrates each one analytically: the gaussian cross-section is evaluated at the ray's closest approach to the axis. The bake carves outflow cavities into the density grid along the axis, with dense walls.
- **Accretion disk.** A flared disk, with its inner rim at 12 units, sits in the equatorial plane. It is sub-sampled where rays cross it. Seen edge-on it reads as a dark lane across the star, which is the look of HH 30.

![Edge-on disk and jets](docs/screenshots/disk-jets.png)

#### Shared data, hazards and interference

Each eruption's rope is 9 control points, recomputed on the CPU every frame. Its front is a centre, radius and cone. Those same values drive the tube, the volume shader and the hazard checks:

- **Plasma contact** with the rope damages the hull directly.
- **The ionized sheath** around the rope drains shields.
- **A shock front** shoves the ship outward and drains shields as it passes.
- **The jet core** is lethal and throws you along the axis. The jet flanks cause interference.

Interference escalates with how close the shock front is (e-folding every 45 units), not just on contact:

1. **Snow and tearing** come first.
2. **Rolling sync bars, scanlines, color fringing and block dropouts** follow as the front closes.
3. **Frame jumps and white-out frames** hit at impact.

The HUD shows a shock marker with an impact countdown and `BRACE` inside 60 units. Its symbology jitters and drops out with the static, while the canopy holds still.

![Interference at 108, 30 and 0 units from a shock front](docs/screenshots/shock-tiers.png)

![Active region on the star before an eruption](docs/screenshots/active-region.png)

## Performance knobs

| Quality | Volume resolution | Steps per ray |
|---|---|---|
| Low (touch default) | 1/3 | 36 |
| Medium | 1/2 | 56 |
| High | 1/2 | 96 |

Ray start is dithered per pixel, which turns step banding into fine grain.

Requires WebGL2, because of the 3D textures.

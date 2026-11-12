# longwind-world

Sky, atmosphere and cloud pieces from [长风 Long Wind](https://github.com/jbang2004/long-wind) (MIT), adapted for a
camera that flies. Plain ES modules: you pass `THREE` in (r161 or later; tested on r161 and r186). No build step and
no other dependencies.

Long Wind's sky was built for a swordsman standing in a field. Its clouds are painted onto the dome, which is right
for that game but not for an aircraft that flies past and through them. The package covers the sky, the clouds and the ground: foliage lighting, ground detail and grass.

| module | what | from Long Wind |
|---|---|---|
| `createCumulus` | Fair-weather cumulus you can fly past and through. Each cloud is a cluster of lit sphere impostors (one instanced quad per puff). Real scale: flat bases at the condensation level, 300 m–1.5 km across, humilis / mediocris / congestus. Lighting: per-puff sun transmittance (CPU march through the cluster, re-baked when the sun moves), grey bases, bright cauliflower tops, a silver lining toward the sun. Edges are eroded by world-locked noise. Sorted far to near each frame. | Lighting approach and noise texture; the impostor field is new |
| `createCloudShadow` | Each cloud body projected along the sun into a small top-down map. `patch(material)` makes lit materials (standard, physical, lambert, phong) scale the sun's direct light by it. Chains existing `onBeforeCompile` hooks. | Long Wind darkens the sun under a procedural noise deck; here the shadows come from the actual clouds |
| `installHeightFog` | Exponential height fog for every material that uses three's fog chunks, keeping `FogExp2` semantics. The fog distance is the view depth times the mean density `exp(-h/H)` along the ray, so haze thins with altitude. | The exact height-fog integral in `atmosphere.js` |
| `createSkyOverlay` | High cirrus, a painted band of distant cumulus just above the horizon, and the night sky (two star layers, the Milky Way, the moon with maria). A transparent dome over any base sky. | Long Wind's `sky.js` GLSL, unchanged apart from uniforms |
| `tuneSky` | Saturation and zenith depth for three's `Sky` (Preetham). Plain Preetham plus ACES at a low exposure stays pale grey-blue at any turbidity. | `wx_skySat`: pre-saturating the open-sky stops |
| `patchFoliage` | Leaf lighting for any stock lit material: warm translucency when you look toward the sun through the leaves, wrap light so thin foliage has no hard terminator, a little self-light so deep canopy never goes black. It reads the *shadowed* sun from three's own light loop, so leaves in shadow (or under a cloud shadow) don't glow. | `foliage.js`'s sunBack / sunWrap terms, moved from a custom shader into a patch |
| `patchGroundDetail` | Close-range ground detail for a vertex-coloured terrain: a `vec4` attribute of surface weights (sand, grass, dirt, rock) picks per-surface grain and hue from the baked noise, with a macro drift that breaks up tiling and a detail normal. Fades out with distance. | Long Wind's terrain splat idea and noise; the weights-as-attribute patch is new |
| `createGrass` | A ring of grass clumps around the camera, one instanced draw. Clumps are placed on the GPU from `gl_InstanceID` on a grid snapped to the camera, sit on the ground from a height/weight texture, collapse where there's no grass, fade at the ring edge and sway with the wind. `groundTexture()` builds the texture from a terrain grid. | Long Wind's grass ring, simplified to one draw with no CPU placement |
| `bakeCloudNoise` | 512² tileable RGBA cloud noise baked once on the GPU: billows, wind streaks, cellular puffs, detail. | Verbatim |
| `pickQuality` | `low` / `med` / `high` from the GPU name, or forced with `?q=` | — |

## Use

```js
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { installHeightFog, bakeCloudNoise, createCumulus, createSkyOverlay, createCloudShadow, tuneSky, pickQuality } from 'longwind-world/index.js';

installHeightFog(THREE, { seaY: 0, scale: 1100 });     // first, before anything compiles
// … renderer (ACES), scene.fog = new THREE.FogExp2(…), Sky, lights, sea …
const tune = tuneSky(sky); tune.sat.value = 2.4; tune.zen.value = 0.8;
const noise = bakeCloudNoise(THREE, renderer);
const q = pickQuality(renderer).tier;
const cu = createCumulus(THREE, { renderer, noise, tile: 26000, seaY: 0, base: 610, quality: q });
scene.add(cu.mesh);
const over = createSkyOverlay(THREE, { noise }); scene.add(over.mesh);
const cs = createCloudShadow(THREE, { renderer, noise, extent: 18000 });
cs.patchScene(scene);                                    // after the scene is built, before the first render

// every frame
cu.update(camera, aircraft.position, { sunDir, sunCol, skyTop, skyBot, dt });
cs.update(cu.casters(), aircraft.position, sunDir, seaY);
const whiteout = cu.inside(camera.position);             // 0..1: thicken your fog when you fly into a cloud
```

### Foliage, ground and grass

```js
import { patchFoliage, patchGroundDetail, createGrass, groundTexture } from 'longwind-world/index.js';

patchFoliage(THREE, leafMaterial, { back: 1.3, wrap: 0.35, trans: 1, glow: 0.05 });   // after any onBeforeCompile of your own
// terrain: geometry.setAttribute('aGround', new THREE.BufferAttribute(weights, 4))  — sand, grass, dirt, rock per vertex
patchGroundDetail(THREE, terrain.material, { noise, near: 220, far: 1300 });
const grass = createGrass(THREE, { ground: groundTexture(THREE, heights, grassWeights, seg),
  rect: { x0, z0, size }, seaY: 0, n: 80, spacing: 2.4, height: 0.8 });
patchFoliage(THREE, grass.material, { back: 1.2, wrap: 0.4 });
scene.add(grass.mesh);
// every frame
grass.update(camera, { time, wind, gust, visible: camera.position.y < 260 });
```

The foliage strengths are relative to a sun of intensity ~3 under ACES at exposure ~0.6. Long Wind's own values
(`back` 2.6, `trans` 1.3) are for its brighter grading and read as neon lime there. Patches chain: `patchFoliage` and
`createCloudShadow().patch()` can go on the same material in either order. Each patch keeps the wrapped
`onBeforeCompile`'s source in `customProgramCacheKey`. three's default key is the hook's source text, which after
wrapping is the same for every patched material, so two materials whose own hooks differ could otherwise share one
program, and one would silently lose its hook.

`examples/flight.html` is a complete minimal scene. Open it through any static server. It loads three r161 from
jsDelivr; use `?three=/path/to/three/` to point it elsewhere. Other URL options: `?e=<sun elevation>`,
`?alt=<metres>`, `?q=low|med|high`, `?still`.

### Lighting units

`createCumulus` expects colours in the same linear units your materials are lit in. For three r155+ physical
lighting, a white cloud under the sun is `sunLight.color × sunLight.intensity / π × ~0.92`. The shader multiplies
that by `sunGain` (default 2): sunlit cumulus is brighter than a Lambert surface because of multiple scattering.
`skyTop` and `skyBot` are the ambient from the sky above and from the sea or ground below.

### Fog and colour space

The cumulus material includes three's fog chunks after tone mapping, as every built-in material does, so clouds melt
into the same haze as your terrain. The overlay blends its horizon haze in display space (`uHazeD`), the way a
three-fogged surface meets the sky at the horizon.

### Cost

Measured in Corsair (`lab/corsair`) at the `low` tier. Frame times under the sandbox's software renderer mean
nothing, so these are GPU-independent counts.

| view | cloud fragments per pixel (screen average) | draw calls (whole frame) |
|---|---|---|
| air start, 1,000 ft | 1.2 (was 0.45 with sprite puffs) | 618 (was 734) |
| dogfight altitude, 4,000 ft | 0.55 (was 0.2) | 700 (was 1,140) |
| island from 5,000 ft | — | 621 (was 1,499) |
| right beside a big cloud | 3.7 over 52% of the screen (worst case) | — |

Fill goes up because the clouds are now real-sized. Draw calls go down because the whole field is one instanced
draw; the old sprites were one call each. The fragment shader does 3 noise texture taps and a few dozen arithmetic operations.
Puffs fade out inside about 1.6 radii of the camera, so flying into a cloud doesn't flood the screen. Hosts handle
the whiteout with fog via `inside()`.

Ground pieces, same measurement: the grass ring is one draw call and one program (72² clumps on `low`, 96² above,
about 36k triangles visible, all culled to nothing off grass). `patchFoliage` adds a handful of ALU to leaf fragments,
`patchGroundDetail` adds 3 noise taps to terrain fragments. Whole-frame draw calls at the strip went from 500 to 501.

Quality tiers: `low` 70 clouds / ~2,600 puffs, `med` 105 / ~4,300, `high` 150 / ~6,700. On integrated GPUs the
other big lever is the host's pixel ratio: fill scales with it.

## Tests

```bash
npm install
npm test               # node: chunk patches against the real three sources, cloud structure, sort, wrap, inside(), sun transmittance, hooks
npm run test:browser   # headless Chrome: compiles and renders examples/flight.html against each three in THREE_DIRS (colon-separated)
```

Both suites pass against three r161.0 and r186.

## Provenance

Every file that carries Long Wind code says so in its header, with the source path. New: `cumulus.js`,
`cloudShadow.js`, `groundDetail.js` (the weights patch), `grass.js` (the GPU-placed ring), `heightFog.js` (the chunk patch), `skyTune.js` (the Preetham patch), `quality.js`, the overlay's
flight adaptations, the tests and the example. MIT; see `LICENSE`.

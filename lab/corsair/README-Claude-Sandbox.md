# Claude sandbox notes: corsair

Single-file three.js page (`index.html`); three.js 0.161 loads from jsDelivr through the import map.

## Setup

- jsDelivr is blocked in the sandbox. Install three locally and point the import map at it in a test copy (never edit the shipped page):
  - `mkdir -p ~/deps && cd ~/deps && npm init -y && npm i three@0.161.0 puppeteer-core`
  - `mkdir -p ~/test && cd ~/test && ln -sfn ~/deps/node_modules/three three`
  - `sed 's#https://cdn.jsdelivr.net/npm/three@0.161.0/#/three/#g' /path/to/index.html > ~/test/index.html`
  - `cd ~/test && python3 -m http.server 8765` (run it in the background; it dies between sessions)
- Headless Chrome is at `/usr/bin/google-chrome`. Launch puppeteer-core with `--no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader`.

## Quirks

- SwiftShader renders at a fraction of a frame per second, so the game's own clock barely moves (frame time is capped at 50 ms). Don't test flight or the dogfight by letting it run. Add a stepping hook to the test copy just before the `// ---- loop` section and drive the sim without rendering:
  - `window.__sim = (sec, ctl) => { const h = 1 / 60; for (let i = 0; i < sec * 60; i++) { t += h; if (ctl) ctl(FM, bandit, i * h); if (FM.on) fmFrame(h); fightFrame(h); } };`
  - Pause with P before taking screenshots, so the stepped state stays put while the cameras keep rendering.
- `V3` in the page is a factory, not a constructor. Inside `evaluate`, use `FM.pos.constructor` to make vectors.
- The Corsair flies a few degrees nose-up, and its guns follow the nose. A test target placed on the velocity vector gets missed. Place it along `(0,0,1).applyQuaternion(FM.q)`.
- The Zero breaks (`bandit.evade > 0`) when you sit behind it pointing at it. To hold it on the gun line for a hit test, reposition it every step.

## Fight testing

- `bandit` and `wing` are AI objects, made by `makeAI(type, team, srcGroup)`, with `pos`, `vel`, `up`, `quat`, `state` (`off`/`alive`/`down`/`wreck`), `mode` (`patrol`/`fight`/`form`), `tgt`, `evade`, `cut` (Zero engine out) and `hp`. `PLAYER` wraps `FM` in the same interface.
- To set up a scenario, call `fmStart('fight')`, then `placeAI(bandit, pos, vel, 'fight')` and `placeAI(wing, ...)`. Expose them through a `window.__fm` hook in the test copy.
- A useful player bot: transform the bandit's lead point into the player's body frame (`le`), then set `ail = atan2(-le.x, le.y) * 2` and `elev = off-angle * 5` (less when the roll error is large). To fly a weave, aim the bot at the wingman instead of the bandit.
- Hold keys through `KEYS.add('KeyS')`, `'KeyW'` and `'KeyX'`. `FM.key.*` gets overwritten by `fmInput` every frame, so setting it directly doesn't hold.

## Cameras and photo testing

- The camera code only runs in the render loop. To check framing while stepping the sim, add a test hook that calls the camera each step: `window.__simCam = sec => { for (...) { t += h; if (FM.on) fmFrame(h); fightFrame(h); if (mode === 'chase') styledCamera(h); } }`. Then screenshot, and project `bandit.g.position` with the camera to check it's on screen.
- The photo is `renderer.domElement.toBlob` right after `renderer.render` (`photoGrab()` in the loop). To verify a real download, call `Browser.setDownloadBehavior` with a `downloadPath` through a CDP session, then press P. Six Fleets' `captureStream` approach never starts playing in headless Chrome, which is why the Corsair doesn't use it.
- `?watch` starts a computer-against-computer fight on load. Esc pauses, C hides the HUD.

## Sky and clouds (lib/longwind-world)

- The page imports `lib/longwind-world/src/` through the import map key `longwind-world/` (`../../lib/longwind-world/src/`). In a test copy, keep the same layout: serve a root that holds `lab/corsair/index.html` and `lib/longwind-world/` (a symlink is fine) next to the local `three/`.
- Library tests: `cd lib/longwind-world && npm install && npm test` (node, no GPU). `THREE_DIRS=<three r161>:<three r186> npm run test:browser` compiles and renders `examples/flight.html` in headless Chrome against each three.js build.
- Handles for headless checks: `CU` (cumulus field: `CU.stats()`, `CU.clusters`, `CU.inside(pos)`), `CS` (cloud shadows: `CS.coverage()` reads back the shadow map), `skyOver`, `skyTune`, `QUAL` (the quality tier and GPU string). Expose them in the test copy's `window.T` the same way as `FM`.
- Cost check that means something under SwiftShader: count the fragments the cloud pass shades per pixel. Render `CU.mesh.geometry` with a ShaderMaterial that shares `CU.uniforms` and `CU.material.vertexShader`, an additive 1/255 fragment output, `depthTest: false`, into a 640x360 target, then read it back. Frame times under SwiftShader are meaningless.
- `?q=low|med|high` forces the cloud tier. Under SwiftShader `pickQuality` returns `low`.
- `installHeightFog` patches `THREE.ShaderChunk` fog chunks at load, so every fogged material's fog distance is height-weighted. If a new custom ShaderMaterial includes `<fog_vertex>`, it must declare `vec4 mvPosition` before that include.

## Island (foliage, ground, grass, surf)

- Island scenes in the test copy use island-local cameras: `ISLE + (x, WATER_Y + y, z)`. Expose `isleMask`, `GRASS` and `island` in `window.T` for probes (`island.userData.reef`, `island.userData.reefU`).
- The scene has two 80 km planes: the sea (scene child 1, `MeshPhysicalMaterial`) and the storm deck at ~2,300 m. Don't find the sea by geometry size.
- `island.userData.reef.material.color` is reset every frame (storm dimming), so a debug colour set on it doesn't stick. Swap the material instead.
- The sea must stay subdivided (64x64). As two triangles it out-depths the reef/surf layer 10 cm above it, everywhere.
- Grass weight comes from the terrain's `aGround` attribute (x sand, y grass, z dirt, w rock): `y + .85 z`, zero on the strip, taxiway and connectors. The grass ring is `lwGrass`; check `GRASS.mesh.visible` (off above 260 m or away from the island).
- `patchFoliage`, `patchGroundDetail` and the cloud-shadow patch chain on one material. Their program keys include the wrapped hook's source; keep that if you add another patch.
- The canvas is transparent (blueprint mode needs it). Leaf alpha-to-coverage leaves fractional alpha at leaf edges, so `sealAlpha()` forces alpha to 1 after every non-blueprint frame. Without it, stills (`p`) and recordings show a white outline on every leaf. To check: capture with `p` and count pixels with alpha < 255 (should be 0).

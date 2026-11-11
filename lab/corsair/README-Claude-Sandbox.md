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

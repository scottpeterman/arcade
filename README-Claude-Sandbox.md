# Claude sandbox notes

- Static site, no build. Serve with `python3 -m http.server 8000` from the repo root.
- `python3 tools/check.py` must pass before committing (exit 1 on errors).
- Thumbnails: `pip install playwright pillow --break-system-packages`, then `python3 tools/thumbs.py <slug>`. Do not run `playwright install`; use the preinstalled Chromium. Launch flags already force SwiftShader for WebGL.
- The sandbox blocks jsDelivr, so Puppis Echo and Ringworld render without their 3D scene. Do not regenerate their thumbnails here; capture them on a machine with network access.
- `tools/capture.py` can render them anyway: npm works here, so `npm install --prefix DIR three@0.147.0 @fontsource/chakra-petch @fontsource/jetbrains-mono @fontsource/saira-semi-condensed @fontsource/ibm-plex-mono @fontsource/share-tech-mono @fontsource/orbitron`, then pass `--vendor DIR`. It serves the same three.js build and the Google Fonts families from that install. SwiftShader is slow: a Deckrunner shot takes about two minutes, because scenes wait on game time, not wall time.
- Banrion's `index.html` is generated: edit `games/banrion/js/*.js` and `chess.html`, then run `python3 bundle.py` from `games/banrion/` and copy the resulting `chess_single.html` over `index.html`.
- Deckrunner's `index.html` is the solid-hull build (V toggles vector). `deckrunner.html` is the older vector-only build.
- Tauri Reach (`lab/tauri-reach/`) loads three.js from jsDelivr, so render it with the `capture.py` vendor routes (`install_vendor_routes`). It exposes `window.__qa` for headless scenes: `fly`, `view`, `place`, `throttle`, `foeAt`, `ai`, `fire`, `advance(sec)` (steps the sim without rendering), `freeze(true)` (holds the sim while frames render), `station`, `killParts`, `stationOrbit`, `inspect`, and `state()`/`stationState()` for numbers. A MED-quality 1600x900 frame takes tens of seconds under SwiftShader; use `__qa.quality(0)` and a small viewport for sim-only checks.

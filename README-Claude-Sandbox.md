# Claude sandbox notes

- Static site, no build. Serve with `python3 -m http.server 8000` from the repo root.
- `python3 tools/check.py` must pass before committing (exit 1 on errors).
- Thumbnails: `pip install playwright pillow --break-system-packages`, then `python3 tools/thumbs.py <slug>`. Do not run `playwright install`; use the preinstalled Chromium. Launch flags already force SwiftShader for WebGL.
- The sandbox blocks jsDelivr, so Puppis Echo and Ringworld render without their 3D scene. Do not regenerate their thumbnails here; capture them on a machine with network access.
- Banrion's `index.html` is generated: edit `games/banrion/js/*.js` and `chess.html`, then run `python3 bundle.py` from `games/banrion/` and copy the resulting `chess_single.html` over `index.html`.
- Deckrunner's `index.html` is the solid-hull build (V toggles vector). `deckrunner.html` is the older vector-only build.

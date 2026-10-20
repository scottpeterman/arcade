# Vector Arcade

Wireframe and vector games for the browser. Each game is a single self-contained HTML page: no build step, no accounts, no server.

**Play:** https://scottpeterman.github.io/arcade/

## Screenshots

<table>
  <tr>
    <td align="center"><img src="games/deckrunner/docs/screenshots/wave-06-dreadnought-ringed-giant.png" width="400" alt="Deckrunner wave 6: running the Dreadnought's deck under a ringed gas giant"><br><b>Deckrunner</b> · wave 6, Dreadnought</td>
    <td align="center"><img src="games/bounty-hunter/docs/screenshots/floor-17-heavies.png" width="400" alt="Bounty Hunter floor 17: robot heavies closing in"><br><b>Bounty Hunter</b> · floor 17, robot tier</td>
  </tr>
  <tr>
    <td align="center"><img src="games/vector-command/docs/screenshots/wave-09-mirv-salvo.png" width="400" alt="Vector Command wave 9: a MIRV salvo splitting over the grid"><br><b>Vector Command</b> · wave 9, MIRV salvo</td>
    <td align="center"><img src="games/puppis-echo/docs/screenshots/wave-10-light-echo.png" width="400" alt="Puppis Echo wave 10: the light echo ring expanding through the field"><br><b>Puppis Echo</b> · wave 10, light echo</td>
  </tr>
  <tr>
    <td align="center"><img src="games/banrion/docs/screenshots/low-angle-kingside.png" width="400" alt="Banrion: a Closed Ruy Lopez midgame against the engine"><br><b>Banrion</b> · vs the engine, move 16</td>
    <td align="center"><img src="lab/ringworld/docs/screenshots/arch.png" width="400" alt="Ringworld: the far side of the ring arching up across the sky"><br><b>Ringworld</b> (lab) · the arch</td>
  </tr>
  <tr>
    <td align="center"><img src="games/normandy/docs/screenshots/hedgehog-cover.png" width="400" alt="Normandy: crouched behind a Czech hedgehog on Omaha Beach, the seawall ahead"><br><b>Normandy</b> · Dog Green, hedgehog cover</td>
    <td align="center"><img src="lab/tauri-reach/docs/screenshots/station-overview.png" width="400" alt="Tauri Reach: the spindle station over the young star's jets"><br><b>Tauri Reach</b> (lab) · the station</td>
  </tr>
</table>

More per game in each `docs/screenshots/` folder.

## Layout

```
index.html            launcher; renders the thumbnail grid from games.json
games.json            the catalog: one entry per game or tool
games/<slug>/         one folder per game; index.html is the playable entry
  index.html
  thumb.webp          640x360 card image
  README.md, docs/, js/, tools/   source and notes, if the game has them
  docs/screenshots/   README screenshots, written by tools/capture.py
lab/<slug>/           experiments and visualizations
lab/thumbs/           thumbnails for lab entries that live inside a game folder
tools/check.py        validates games.json against the tree
tools/thumbs.py       captures thumbnails with headless Chromium
tools/capture.py      stages later levels and captures README screenshots and promo frames
promo/                hero frames from capture.py (gitignored)
```

`tools/capture.py` drives each game through its own functions to a later level, lets it play, then captures: 1600x900 screenshots into `docs/screenshots/`, and one hero frame per game into `promo/` at 1600x900 and 1080x1350. Run `python3 tools/capture.py` for everything or name slugs; the scenes for each game are at the bottom of the script.

## Adding a game

1. Put the game at `games/<slug>/index.html`.
2. Add an entry to `games.json`:

```json
{
  "slug": "my-game",
  "title": "My Game",
  "tagline": "One line that sells it.",
  "path": "games/my-game/",
  "thumb": "games/my-game/thumb.webp",
  "tags": ["shooter", "3d"],
  "input": ["keyboard", "touch"],
  "players": "1",
  "shelf": "featured"
}
```

3. Generate the thumbnail and validate:

```
python3 tools/thumbs.py my-game
python3 tools/check.py
```

`shelf` is `featured` (Games) or `lab` (Lab & tools). Tags drive the filter buttons automatically. An entry with no thumbnail gets a title card.

If a capture lands on a splash or a blank WebGL frame, either drop in a real screenshot as `thumb.webp` (any 16:9 image, 640x360) or set `thumb_wait`, `thumb_click` or `thumb_query` on the entry; see the header of `tools/thumbs.py`.

## Running locally

The launcher fetches `games.json`, so it needs HTTP rather than `file://`:

```
python3 -m http.server 8000
```

The games themselves still open straight from disk.

## Network use

- Banrion online play uses an outbound WebSocket to a public MQTT broker. Hot-seat and vs-computer need no network.
- Puppis Echo and Ringworld load three.js from jsDelivr.
- Several games request Google Fonts and fall back to system fonts without it.

## License

Each game folder carries its own license and third-party notices.

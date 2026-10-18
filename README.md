# Vector Arcade

Wireframe and vector games for the browser. Each game is a single self-contained HTML page: no build step, no accounts, no server.

**Play:** https://scottpeterman.github.io/arcade/

## Layout

```
index.html            launcher; renders the thumbnail grid from games.json
games.json            the catalog: one entry per game or tool
games/<slug>/         one folder per game; index.html is the playable entry
  index.html
  thumb.webp          640x360 card image
  README.md, docs/, js/, tools/   source and notes, if the game has them
lab/<slug>/           experiments and visualizations
lab/thumbs/           thumbnails for lab entries that live inside a game folder
tools/check.py        validates games.json against the tree
tools/thumbs.py       captures thumbnails with headless Chromium
```

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

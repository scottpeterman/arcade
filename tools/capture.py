#!/usr/bin/env python3
"""Capture README screenshots and promo hero frames for the arcade.

Each game has a scene list in SCENES: how to start it, how to reach a later level,
and when to take each shot. Scenes drive the real game through its own functions in
the page (page.evaluate runs in the page's global scope), then let it play for a few
seconds so every frame is a genuine game frame. No game file is modified.

Outputs
  games/<slug>/docs/screenshots/<name>.png     README shots, 1600x900
  lab/<slug>/docs/screenshots/<name>.png       same, for lab entries
  promo/<slug>-16x9.png                        hero frame, 1600x900
  promo/<slug>-4x5.png                         hero frame, 1080x1350

Usage
  python3 tools/capture.py                     all games
  python3 tools/capture.py deckrunner banrion  just these slugs
  python3 tools/capture.py --hero-only         promo frames only
  python3 tools/capture.py deckrunner --only wave-03-destroyer-orbit hero
                                               just these shots ("hero" = both promo frames)
  python3 tools/capture.py --vendor DIR        offline: serve three.js and Google Fonts
                                               from an npm install in DIR (see below)

Offline mode (sandboxes that block jsDelivr and Google Fonts):
  npm install --prefix DIR three@0.147.0 @fontsource/chakra-petch @fontsource/jetbrains-mono
      @fontsource/saira-semi-condensed @fontsource/ibm-plex-mono @fontsource/share-tech-mono
      @fontsource/orbitron
(one command; wrapped here for width). With a network connection, leave --vendor off.

Needs: pip install playwright pillow  (and a Chromium playwright can find)
"""
import argparse
import functools
import http.server
import pathlib
import re
import threading
import urllib.parse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
WIDE = (1600, 900)
TALL = (1080, 1350)
LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
               "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    # declare UTF-8 the way GitHub Pages does; pages without a <meta charset> would
    # otherwise decode as Windows-1252 (a middle dot becomes "Â·")
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                      ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8"}

    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# ------------------------------------------------------------------ offline vendor routes
def install_vendor_routes(context, vendor):
    nm = pathlib.Path(vendor) / "node_modules"
    three = nm / "three"

    def cdn(route):
        path = urllib.parse.urlparse(route.request.url).path        # /npm/three@0.147.0/build/three.min.js
        m = re.match(r"^/npm/three@[^/]+/(.+)$", path)
        f = three / m.group(1) if m else None
        if f and f.is_file():
            route.fulfill(path=str(f), content_type="application/javascript")
        else:
            route.abort()

    def font_css(route):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
        css = []
        for fam in q.get("family", []):
            name, _, spec = fam.partition(":")
            weights = re.findall(r"\d{3}", spec) or ["400"]
            pkg = name.lower().replace("+", "-").replace(" ", "-")
            for w in weights:
                f = nm / "@fontsource" / pkg / "files" / f"{pkg}-latin-{w}-normal.woff2"
                if f.is_file():
                    css.append("@font-face{font-family:'%s';font-style:normal;font-weight:%s;font-display:block;"
                               "src:url(https://fonts.local/%s) format('woff2');}" % (name.replace("+", " "), w, f.relative_to(nm)))
        route.fulfill(body="\n".join(css), content_type="text/css")

    def font_file(route):
        rel = urllib.parse.urlparse(route.request.url).path.lstrip("/")
        f = nm / rel
        if f.is_file():
            route.fulfill(path=str(f), content_type="font/woff2")
        else:
            route.abort()

    context.route("https://cdn.jsdelivr.net/**", cdn)
    context.route("https://fonts.googleapis.com/**", font_css)
    context.route("https://fonts.local/**", font_file)
    context.route("https://fonts.gstatic.com/**", lambda r: r.abort())
    context.route("https://unpkg.com/**", lambda r: r.abort())        # Banrion's online-play transport


# ------------------------------------------------------------------ helpers for scenes
class Shot:
    """Context handed to each scene: the page plus small helpers."""

    def __init__(self, page, base, size):
        self.page, self.base, self.size = page, base, size

    def open(self, path, wait=1500):
        self.page.goto(self.base + path, wait_until="load", timeout=60000)
        self.page.wait_for_timeout(wait)

    def js(self, code):
        return self.page.evaluate(code)

    def key(self, k, wait=250):
        self.page.keyboard.press(k)
        self.page.wait_for_timeout(wait)

    def wait(self, ms):
        self.page.wait_for_timeout(ms)

    def css(self, rule):
        self.page.add_style_tag(content=rule)

    # Game-time clock for games whose code is closed over: counts frames the way most of
    # these loops do (dt clamped to 0.05 s), so waits track game time under slow software GL.
    GAME_CLOCK = """(() => { window.__gt = 0; let last = null; const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => raf(ts => { if (last !== null && ts !== last) window.__gt += Math.min(0.05, (ts - last) / 1000);
        last = ts; cb(ts); }); })()"""

    def game_clock(self):
        self.page.add_init_script(self.GAME_CLOCK)

    def game_wait(self, sec):
        t0 = self.js("window.__gt")
        self.page.wait_for_function(f"window.__gt > {t0 + sec}", timeout=900000, polling=250)


def snap(page, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out), type="png", timeout=180000)
    print("  wrote", out.relative_to(ROOT))


# Scenes are filled in below: SCENES[slug] = {"path": ..., "readme": [(name, fn), ...], "hero": fn}
SCENES = {}


def run(slugs, hero_only, vendor, only=None):
    httpd = serve()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/"
    with sync_playwright() as p:
        browser = p.chromium.launch(args=LAUNCH_ARGS)
        for slug in slugs:
            sc = SCENES[slug]
            print(slug)
            jobs = []
            if not hero_only:
                for name, fn in sc["readme"]:
                    if not only or name in only:
                        jobs.append((fn, WIDE, ROOT / sc["dir"] / "docs" / "screenshots" / f"{name}.png"))
            if not only or "hero" in only:
                jobs.append((sc["hero"], WIDE, ROOT / "promo" / f"{slug}-16x9.png"))
                jobs.append((sc.get("hero_tall", sc["hero"]), TALL, ROOT / "promo" / f"{slug}-4x5.png"))
            for fn, size, out in jobs:
                context = browser.new_context(viewport={"width": size[0], "height": size[1]})
                if vendor:
                    install_vendor_routes(context, vendor)
                page = context.new_page()
                errs = []
                page.on("pageerror", lambda e, errs=errs: errs.append(str(e)))
                try:
                    fn(Shot(page, base, size))
                    snap(page, out)
                except Exception as e:
                    print(f"  FAIL {out.name}: {e}")
                if errs:
                    print("  page errors:", errs[:3])
                context.close()
        browser.close()
    httpd.shutdown()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slugs", nargs="*")
    ap.add_argument("--hero-only", action="store_true")
    ap.add_argument("--vendor", help="dir with an npm install of three@0.147.0 and @fontsource fonts")
    ap.add_argument("--only", nargs="+", help="shot names to capture; 'hero' for the promo frames")
    a = ap.parse_args()
    slugs = a.slugs or list(SCENES)
    bad = [s for s in slugs if s not in SCENES]
    if bad:
        ap.error("unknown slug(s): " + ", ".join(bad) + " (have: " + ", ".join(SCENES) + ")")
    run(slugs, a.hero_only, a.vendor, a.only)


# ================================================================== scenes
# (per-game scene functions follow)

# ---- Deckrunner: ?wave=N jumps straight to a wave. Play a few seconds with the guns
# hot so the frame has fighters, bolts and turret fire, then pause and frame it.
def deckrunner(wave, play_ms, yaw=0.0, pitch=None, roll=0.0, world=None):
    def fn(t):
        q = f"?wave={wave}&fine=1&debug" + (f"&world={world}" if world else "")
        t.open("games/deckrunner/index.html" + q, 1200)
        t.key("Enter", 500)
        t.key("Space", 400)                          # engage
        t.page.keyboard.down("Space")                # guns hot
        # software GL runs the game well under real time (dt is capped per frame), so
        # wait on the game's own clock, not the wall clock
        t0 = t.js("DR.game.time")
        t.page.wait_for_function(f"DR.game.time > {t0 + play_ms / 1000}", timeout=600000, polling=250)
        t.page.keyboard.up("Space")
        t.key("KeyP", 300)
        t.css("#pause{display:none!important}")
        if yaw or roll or pitch is not None:
            t.js(f"Object.assign(DR.cam,{{yaw:DR.cam.yaw+{yaw},roll:{roll}}})" +
                 (f";DR.cam.pitch={pitch}" if pitch is not None else ""))
        t.wait(700)
    return fn

SCENES["deckrunner"] = {
    "dir": "games/deckrunner",
    "readme": [
        ("wave-03-destroyer-orbit", deckrunner(3, 7000, yaw=0.24, pitch=-0.16, roll=-0.2)),
        ("wave-04-heavy-cruiser-sponsons", deckrunner(4, 6000, yaw=-0.18, roll=0.16)),
        ("wave-06-dreadnought-ringed-giant", deckrunner(6, 6500, yaw=-0.12)),
        ("wave-07-starbase-rim", deckrunner(7, 9000)),
    ],
    "hero": deckrunner(6, 6500, yaw=-0.14, roll=0.08),
}


# ---- Bounty Hunter: #floorN loads that floor (11-20 are the robot tier, 20 has BANE).
# Face the nearest enemy, let them close in, then fire and catch the bolt in flight.
def bounty(floor, close_ms, boss=False, fire=True):
    def fn(t):
        t.open(f"games/bounty-hunter/index.html#floor{floor}", 300)
        t.page.wait_for_function("game.mode === 'title'", timeout=30000)
        t.js("startGame()")
        t.wait(400)
        # pick the boss, or the enemy with the most company within 4 cells; stand 2-4 cells
        # from it on an open cell with line of sight, facing it
        ok = t.js("""(boss => {
          game.invuln = 1e9; game.paused = false; game.score = 8000 + %d * 1375;
          const es = game.enemies.filter(e => e.hp > 0);
          const crowd = e => es.filter(o => Math.hypot(o.x - e.x, o.z - e.z) < 4).length;
          const pick = boss ? es.find(e => e.type === 'boss') : es.slice().sort((a, b) => crowd(b) - crowd(a))[0];
          if (!pick) return false;
          let best = null;
          for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
            const gx = Math.floor(pick.x) + dx, gz = Math.floor(pick.z) + dz, d = Math.hypot(dx, dz);
            if (d < 2 || d > 4.2 || blocks(gx, gz)) continue;
            const x = gx + 0.5, z = gz + 0.5;
            if (!hasLOS(x, z, pick.x, pick.z)) continue;
            const seen = es.filter(o => hasLOS(x, z, o.x, o.z)).length, score = seen * 2 - Math.abs(d - 3.2);
            if (!best || score > best.score) best = { x, z, score };
          }
          if (!best) return false;
          game.px = best.x; game.pz = best.z; game.pa = Math.atan2(pick.z - game.pz, pick.x - game.px);
          window.__pick = pick; return true;
        })(%s)""" % (floor, "true" if boss else "false"))
        if not ok:
            raise RuntimeError("no staging spot found")
        t.wait(close_ms)
        t.js("""(() => { const p = window.__pick; game.paused = false;
          if (p && p.hp > 0) game.pa = Math.atan2(p.z - game.pz, p.x - game.px); })()""")
        t.wait(120)
        if fire:
            t.js("tryCast()")
            t.wait(90)
    return fn

SCENES["bounty-hunter"] = {
    "dir": "games/bounty-hunter",
    "readme": [
        ("floor-12-robot-tier", bounty(12, 1200)),
        ("floor-17-heavies", bounty(17, 1400)),
        ("floor-20-bane", bounty(20, 1200, boss=True, fire=False)),
    ],
    "hero": bounty(17, 1400),
}


# ---- Vector Command: no title screen; reset() then jump the wave counter. Stack extra
# MIRVs, let the trails cross the sky, fire interceptors just ahead of them, freeze.
def vcommand(wave, extra, score):
    def fn(t):
        t.open("games/vector-command/index.html", 800)
        t.js("el('audio-btn').style.display='none'")
        t.js(f"""(() => {{ reset(); wave = {wave - 1}; incoming = []; counters = []; blasts = []; nextWave(); score = {score};
          for (let i = 0; i < {extra}; i++) spawnIncoming(null, null, i % 2 ? 'MIRV' : 'SINGLE');
          for (let i = 0; i < 46; i++) update(0.05); }})()""")
        # intercept: aim ahead of the lowest few threats
        t.js("""(() => { const live = incoming.slice().sort((a, b) => b.y - a.y).slice(0, 6);
          for (const m of live) { const vx = (m.tx - m.x), vy = (m.ty - m.y), L = Math.hypot(vx, vy) || 1;
            fireCounter(m.x + vx / L * 60, m.y + vy / L * 60); }
          for (let i = 0; i < 9; i++) update(0.05); running = false; })()""")
        t.page.mouse.move(t.size[0] * 0.55, t.size[1] * 0.42)
        t.wait(500)
    return fn

SCENES["vector-command"] = {
    "dir": "games/vector-command",
    "readme": [
        ("wave-05", vcommand(5, 4, 2650)),
        ("wave-09-mirv-salvo", vcommand(9, 10, 7425)),
        ("wave-12-saturation", vcommand(12, 14, 12880)),
    ],
    "hero": vcommand(10, 12, 9640),
}


# ---- Puppis Echo: game code is closed over; __qa.start() begins play, and an init
# script catches the state object S when resetGame() assigns it. Jump the wave, hold the
# lance and thrust, then trigger the light echo and catch the ring mid-expansion.
PUPPIS_HOOK = """(() => { const oa = Object.assign;
  Object.assign = function (t, ...s) { if (s[0] && s[0].running === true && 'wave' in s[0]) window.__S = t; return oa.call(this, t, ...s); }; })()"""

def puppis(wave, settle_s, echo_s=0.9):
    def fn(t):
        t.page.add_init_script(PUPPIS_HOOK)
        t.game_clock()
        t.open("games/puppis-echo/index.html", 500)
        t.page.wait_for_function("window.__ready === true", timeout=60000)
        t.js("__qa.start()")
        t.game_wait(0.3)
        t.js(f"""(() => {{ const S = window.__S; S.rocks.forEach(r => r.m.parent.remove(r.m)); S.rocks.length = 0;
          S.wave = {wave - 1}; S.inv = 1e9; S.score = {wave} * 2150; }})()""")
        t.page.wait_for_function(f"window.__S.wave >= {wave} && window.__S.rocks.length > 0", timeout=900000, polling=250)
        t.game_wait(settle_s)
        t.page.keyboard.down("Space"); t.page.keyboard.down("KeyW")
        t.game_wait(0.8)
        t.page.keyboard.up("KeyW")
        t.js("(() => { const S = window.__S; S.echoR = 6; S.echoHit = false; })()")
        t.game_wait(echo_s)
        t.page.keyboard.up("Space")
    return fn

SCENES["puppis-echo"] = {
    "dir": "games/puppis-echo",
    "readme": [
        ("wave-06", puppis(6, 3.0)),
        ("wave-10-light-echo", puppis(10, 3.5)),
        ("wave-14-constellation", puppis(14, 4.0, echo_s=0.6)),
    ],
    "hero": puppis(12, 3.5),
}


# ---- Ringworld (lab): a scene, not a game. __qa.go(view) + skip() jump the camera
# flight, __qa.day() puts the sun over the camera. Overlays stay for README shots and
# go for the hero.
def ringworld(view, settle_ms=2500, clean=False, day=True, fly=None):
    def fn(t):
        t.open("lab/ringworld/index.html", 500)
        t.page.wait_for_function("window.__ready === true", timeout=60000)
        t.js(f"__qa.go('{view}'); __qa.skip();" + (f" __qa.fly({fly});" if fly is not None else ""))
        t.wait(1200)                                 # let the camera flight land first
        if day:
            t.js("__qa.day()")                       # sun over the camera's current spot
        if clean:
            t.js("document.querySelectorAll('#spec,#status,#caption,#hint,#dock').forEach(e => e.hidden = true)")
        t.wait(settle_ms)
    return fn

SCENES["ringworld"] = {
    "dir": "lab/ringworld",
    "readme": [
        ("system", ringworld("system", day=False)),
        ("rim", ringworld("rim")),
        ("arch", ringworld("arch")),
        ("fist-of-god", ringworld("fist")),
    ],
    "hero": ringworld("arch", clean=True),
}

# ---- Banrion: modules hang off window (Game, Engine, Render3D). Start a game vs the engine,
# replay a Closed Ruy Lopez to move 16 with White (you) to move so the engine waits, then
# frame the board. onGameChanged() redraws the 3D board, 2D board and move list.
RUY = ("e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5 Bc2 c5 d4 Qc7 "
       "Nbd2 cxd4 cxd4 Nc6 Nb3 a5 Be3 a4 Nbd2 Bd7").split()

def banrion(yaw=None, pitch=None, dist=None, clean=False):
    def fn(t):
        t.open("games/banrion/index.html", 800)
        t.js("dismissSplash()")
        t.wait(300)
        t.js("Engine.setLevel('club'); goCpu()")
        t.page.wait_for_function("window.Game && Game.mode === 'cpu'", timeout=30000)
        t.wait(500)
        bad = t.js("""(moves => { for (const m of moves) { if (!Game.chess.move(m)) return m; }
          const h = Game.chess.history({ verbose: true }), l = h[h.length - 1];
          Render3D.lastMove = Board2D.lastMove = { from: l.from, to: l.to }; onGameChanged(); return null; })(%s)""" % repr(RUY).replace("'", '"'))
        if bad:
            raise RuntimeError("illegal move in replay: " + bad)
        if clean:
            t.css("#panel{display:none!important}")
            t.js("Render3D.resize()")
        if yaw is not None or pitch is not None or dist is not None:
            t.js("(() => { const c = Render3D.cam;" + (f"c.yaw={yaw};" if yaw is not None else "") +
                 (f"c.pitch={pitch};" if pitch is not None else "") + (f"c.dist={dist};" if dist is not None else "") +
                 "Render3D._dirty = true; })()")
        t.wait(1500)
    return fn

SCENES["banrion"] = {
    "dir": "games/banrion",
    "readme": [
        ("vs-engine-ruy-lopez", banrion()),
        ("low-angle-kingside", banrion(yaw=0.55, pitch=0.45, dist=13.2)),
        ("overhead", banrion(pitch=1.38, dist=15)),
    ],
    "hero": banrion(yaw=0.5, pitch=0.52, dist=14.2, clean=True),
    "hero_tall": banrion(yaw=0.3, pitch=0.62, dist=11.5, clean=True),    # portrait: closer, steeper
}


# ---- Normandy: window.__qa stages the beach. Drop into a stage, place the camera, let the
# sim run (MG bursts, riflemen, tracers), then freeze it so the frame renders clean.
# __qa.advance() steps the sim without rendering; freeze(true) holds it while frames draw.
def normandy(stage, place=None, run_s=1.5, door=False, hero_pose=None):
    def fn(t):
        t.open(f"games/normandy/index.html?stage={stage}&start=1", 300)
        t.page.wait_for_function("window.__qa && window.__qa.ready", timeout=120000)
        t.js("(() => { const d = __qa.dbg(); d.pl.hp = 1e9; })()")     # stays alive while the sim runs
        if place:
            x, z, yaw, pitch, crouch = place
            t.js(f"__qa.place({x}, {z}, {yaw}, {pitch}, {'true' if crouch else 'false'})")
        t.js(f"__qa.advance({run_s})")
        if door:
            # face the crew in the doorway
            t.js("""(() => { const d = __qa.dbg(), c = d.game.enemies.filter(e => e.crew && e.post === 'door');
              if (!c.length) return; const e = c[0]; d.pl.yaw = Math.atan2(e.x - d.pl.x, e.z - d.pl.z) + 0.08; d.pl.pitch = -0.02; })()""")
        t.js("(() => { const d = __qa.dbg(); d.pl.hp = 100; d.game.msgs = []; __qa.freeze(true); })()")
        t.wait(900)
    return fn

SCENES["normandy"] = {
    "dir": "games/normandy",
    "readme": [
        ("ramp-down", normandy(1, (0, -11.5, 0.05, 0.03, False), run_s=2.2)),
        ("hedgehog-cover", normandy(2, (-6.4, 30.0, 0.22, 0.04, True), run_s=2.6)),
        ("seawall-approach", normandy(2, (-14, 84, 0.22, 0.07, False), run_s=1.6)),
        ("casemate-slit", normandy(4, (8, 108.2, 1.32, 0.05, False), run_s=1.0)),
        ("rear-door", normandy(5, (19.6, 122.4, 3.1, 0.0, False), run_s=2.0, door=True)),
    ],
    "hero": normandy(2, (-6.4, 30.0, 0.22, 0.04, True), run_s=2.6),
}


if __name__ == "__main__":
    main()

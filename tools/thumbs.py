#!/usr/bin/env python3
"""Capture a 16:9 thumbnail for every entry in games.json.

Serves the repo root on a local port, opens each entry's path in headless
Chromium, waits, screenshots at 1280x720 and writes a 640x360 WebP to the
entry's "thumb" path.

  python3 tools/thumbs.py                 # missing thumbs only
  python3 tools/thumbs.py --force         # regenerate all
  python3 tools/thumbs.py deckrunner      # just these slugs (implies --force)
  python3 tools/thumbs.py --wait 6000     # ms to wait after load (default 4000)

Per-entry overrides in games.json (all optional):
  "thumb_wait": 8000          ms to wait for this entry
  "thumb_query": "?demo=1"    appended to the URL for the capture
  "thumb_click": true         click the canvas centre once before waiting (skip splash)

Needs: pip install playwright pillow  (and a Chromium playwright can find)
"""
import argparse
import functools
import http.server
import io
import json
import pathlib
import threading

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 1280, 720


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slugs", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--wait", type=int, default=4000)
    args = ap.parse_args()

    manifest = json.loads((ROOT / "games.json").read_text(encoding="utf-8"))
    entries = [g for g in manifest["games"] if g.get("thumb")]
    if args.slugs:
        entries = [g for g in entries if g["slug"] in args.slugs]
        args.force = True
    if not args.force:
        entries = [g for g in entries if not (ROOT / g["thumb"]).exists()]
    if not entries:
        print("nothing to do")
        return

    httpd = serve()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/"
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
        for g in entries:
            page = browser.new_page(viewport={"width": W, "height": H})
            url = base + g["path"] + g.get("thumb_query", "")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                if g.get("thumb_click"):
                    page.mouse.click(W / 2, H / 2)
                page.wait_for_timeout(g.get("thumb_wait", args.wait))
                png = page.screenshot(type="png")
            except Exception as e:
                print(f"FAIL {g['slug']}: {e}")
                page.close()
                continue
            out = ROOT / g["thumb"]
            out.parent.mkdir(parents=True, exist_ok=True)
            Image.open(io.BytesIO(png)).convert("RGB").resize((640, 360), Image.LANCZOS).save(out, "WEBP", quality=82, method=6)
            print(f"ok   {g['slug']} -> {g['thumb']} ({out.stat().st_size // 1024} KB)")
            page.close()
        browser.close()
    httpd.shutdown()


if __name__ == "__main__":
    main()

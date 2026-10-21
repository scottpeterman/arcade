#!/usr/bin/env python3
"""Headless screenshots and sim checks for Normandy.

  python3 tools/shots.py OUTDIR [WIDTHxHEIGHT] [beach|d1]
"""
import sys, os, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1]
w, h = map(int, (sys.argv[2] if len(sys.argv) > 2 else '1280x800').split('x'))
os.makedirs(out, exist_ok=True)

SCENES = [
    ('title', None),
    ('boat', "__qa.start(); __qa.advance(1.0);"),
    ('ramp', "__qa.play(); __qa.place(0,-20.5,0,0.0); __qa.advance(0.5);"),
    ('beach', "__qa.play(); __qa.place(4,22,0.15,0.04); __qa.advance(1.5);"),
    ('hedge', "__qa.play(); __qa.place(-12.6,57,0.4,0.05,true); __qa.advance(1.2);"),
    ('medkit', "__qa.play(); __qa.place(-8,27.5,0.4,-0.12,true); __qa.advance(0.4);"),
    ('seawall', "__qa.play(); __qa.place(-2,97,-0.9,0.1); __qa.advance(0.8);"),
    ('behind', "__qa.play(); __qa.place(-6,104.5,1.2,0.05); __qa.advance(0.6);"),
    ('bunker', "__qa.play(); __qa.place(8,108,1.3,0.06); __qa.advance(0.6);"),
    ('lookback', "__qa.play(); __qa.place(18,110.5,3.3,-0.12); __qa.advance(0.6);"),
]
# D-1: the flat, the wall, the blast (mouth silenced, fuse set, 0.4 s after it goes), the draw
QUIET = "(() => { const d = __qa.dbg(); for (const B of d.EMPS) B.alive = false; })();"
SCENES_D1 = [
    ('d1_brief', "__qa.stage(6);"),
    ('d1_flat', "__qa.level(2); __qa.advance(0.5);"),
    ('d1_mouth', "__qa.level(2); __qa.place(14,13.5,-0.9,0.12,true); __qa.advance(0.6);"),
    ('d1_wall', "__qa.stage(7); __qa.advance(0.6);"),
    ('d1_blast', "__qa.stage(7); " + QUIET + " __qa.place(5.97,32.15,0,0,true); __qa.advance(3.4); __qa.place(2.2,3,0.02,0.12,true); __qa.advance(20.0);"),
    ('d1_draw', "__qa.stage(8); __qa.place(3.2,62,0.03,0.05); __qa.advance(1.0);"),
    ('d1_tunnel', "__qa.stage(8); __qa.place(5,124,1.2,0.0); __qa.advance(0.4);"),
    ('d1_lookback', "__qa.stage(8); __qa.place(4,120,3.1,-0.02); __qa.advance(0.4);"),
    ('d1_head', "__qa.stage(9); __qa.place(4.5,214,-0.02,0.05); __qa.advance(0.6);"),
]
if len(sys.argv) > 3 and sys.argv[3] == 'd1':
    SCENES = SCENES_D1

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': w, 'height': h})
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('file://' + os.path.join(ROOT, 'dist', 'index.html'))
    pg.wait_for_function('window.__qa && window.__qa.ready', timeout=120000)
    print('build ms', pg.evaluate('__qa.buildMs'))
    if h > w: pg.evaluate('__qa.touchOn()')
    for name, js in SCENES:
        if js:
            pg.evaluate(js)
        pg.evaluate('__qa.freeze(true)')
        pg.wait_for_timeout(250)
        pg.screenshot(path=os.path.join(out, name + '.png'))
        print(name, json.dumps(pg.evaluate('__qa.state()')))
        pg.evaluate('__qa.freeze(false)')
    print('errors:', errs[:10])
    b.close()

#!/usr/bin/env python3
"""Headless screenshots and sim checks for Normandy.

  python3 tools/shots.py OUTDIR [WIDTHxHEIGHT]
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

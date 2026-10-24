#!/usr/bin/env python3
"""Merge a painted soldier sheet into Normandy's sprite atlases.

  python3 tools/paint_frames.py SHEET.png MAP.json OUT_PREFIX
  python3 tools/paint_frames.py SHEET.png --index INDEX.png

The sheet is free-form: figures on a soft blurred background, no labels, no grid.
Figures are cut out by detail (the background has none at small scales), numbered
row by row, and MAP.json names which figure plays each state in the five drawn
views S SW W NW N. SE, E and NE are the mirrors of SW, W and NW.

MAP.json "fit": "height" scales each painted frame to the height of the old frame it
replaces, so every pose keeps the old sprite's size on screen (the old sheet draws a
kneeling man as tall as a standing one). Without it the poses keep the painting's own
proportions, scaled as one by the standing height.

Writes three atlases, each the matching soldier_blue atlas with the painted frames
put in by name, so states the map leaves out keep their old frames:
  OUT_PREFIX.png/json      painted frames scaled to soldier_blue's stand height
  OUT_PREFIX_hi.png/json   scaled to soldier_blue_hi's stand height
  OUT_PREFIX_hi2.png/json  painted frames only, at the sheet's own resolution
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as nd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from slice_sprites import helmet_x

DIRS = {'S': 0, 'SE': 1, 'E': 2, 'NE': 3, 'N': 4, 'NW': 5, 'W': 6, 'SW': 7}
MIRROR = {'SW': 'SE', 'W': 'E', 'NW': 'NE'}


def figures(path):
    a = np.asarray(Image.open(path).convert('RGB'))
    l = a.astype(np.float32).mean(-1)
    m = np.abs(l - nd.gaussian_filter(l, 2.0)) > 6
    m = nd.binary_opening(nd.binary_fill_holes(nd.binary_closing(m, iterations=1)), iterations=1)
    lab, n = nd.label(m)
    sz = nd.sum(m, lab, range(1, n + 1))
    objs = nd.find_objects(lab)
    big = [i for i in range(n) if sz[i] > 2500]
    # row-major: rows by a gap in figure tops, then left to right
    big.sort(key=lambda i: objs[i][0].start)
    rows, cur = [], []
    for i in big:
        if cur and objs[i][0].start - objs[cur[0]][0].start > 60:
            rows.append(cur); cur = []
        cur.append(i)
    rows.append(cur)
    order = [i for r in rows for i in sorted(r, key=lambda i: objs[i][1].start)]
    out = []
    for i in order:
        sl = objs[i]
        keep = nd.binary_erosion(lab[sl] == i + 1, iterations=1)
        rgba = np.dstack([a[sl], np.where(keep, 255, 0).astype(np.uint8)])
        out.append(rgba)
    return a, lab, objs, order, out


def index_sheet(path, dst):
    a, lab, objs, order, _ = figures(path)
    keep = np.isin(lab, [i + 1 for i in order])
    chk = np.indices(lab.shape).sum(0) // 12 % 2
    bg = np.where(chk[..., None], [235, 235, 235], [200, 200, 200]).astype(np.uint8)
    im = Image.fromarray(np.where(keep[..., None], a, bg))
    d = ImageDraw.Draw(im); f = ImageFont.load_default(size=26)
    for k, i in enumerate(order):
        x, y = objs[i][1].start + 2, objs[i][0].start
        d.rectangle((x, y, x + 34, y + 28), fill=(255, 255, 0)); d.text((x + 2, y), str(k), fill=(200, 0, 0), font=f)
    im.save(dst)
    print(f'{len(order)} figures -> {dst}')


def trim(img):
    ys, xs = np.nonzero(img[..., 3] > 0)
    return img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def unblood(img):
    """Hit and die frames only: turn blood-red pixels a dull brown of the same brightness.
    Cutting them out, as the pixel sheet does, punches holes in painted skin and lips."""
    a = img.copy()
    r, g, b = (a[..., i].astype(int) for i in range(3))
    blood = (a[..., 3] > 0) & (r > 110) & (g < 75) & (b < 75) & (r > 2.0 * g + 20)
    l = (0.299 * r + 0.587 * g + 0.114 * b)[blood]
    a[blood, 0] = np.clip(l * 1.15, 0, 255); a[blood, 1] = np.clip(l * 0.95, 0, 255); a[blood, 2] = np.clip(l * 0.8, 0, 255)
    return a


def frame(img, state):
    img = trim(unblood(img) if state in ('hit', 'die') else img)
    h, w = img.shape[:2]
    ax = w / 2 if state == 'die' else helmet_x(img, 0, 0)
    return img, ax, h


def scaled(img, ax, ay, k):
    if k == 1:
        return img, ax, ay
    h, w = img.shape[:2]
    nw, nh = max(1, round(w * k)), max(1, round(h * k))
    p = Image.fromarray(img)
    rgb = np.array(p.convert('RGB').resize((nw, nh), Image.LANCZOS))
    al = np.array(p.getchannel('A').resize((nw, nh), Image.BOX))
    return np.dstack([rgb, np.where(al > 127, 255, 0).astype(np.uint8)]), ax * k, round(ay * k)


def load_atlas(prefix):
    sheet = np.array(Image.open(prefix + '.png').convert('RGBA'))
    table = json.load(open(prefix + '.json'))
    return {n: (sheet[y:y + h, x:x + w].copy(), ax, ay) for n, (x, y, w, h, ax, ay) in table.items()}


def save_atlas(frames, out):
    W = 1024 if max(f[0].shape[1] for f in frames.values()) < 1024 else 2048
    items = sorted(frames.items(), key=lambda kv: -kv[1][0].shape[0])
    x = y = sh = 0; pos = {}
    for n, (img, _, _) in items:
        h, w = img.shape[:2]
        if x + w + 1 > W:
            x = 0; y += sh + 1; sh = 0
        pos[n] = (x, y); x += w + 1; sh = max(sh, h)
    atlas = np.zeros((y + sh, W, 4), np.uint8)
    table = {}
    for n, (img, ax, ay) in items:
        px, py = pos[n]; h, w = img.shape[:2]
        atlas[py:py + h, px:px + w] = img
        table[n] = [px, py, w, h, round(ax, 1), int(ay)]
    Image.fromarray(atlas).save(out + '.png', optimize=True)
    json.dump(table, open(out + '.json', 'w'), separators=(',', ':'))
    return atlas.shape


def main():
    sheet = sys.argv[1]
    if sys.argv[2] == '--index':
        index_sheet(sheet, sys.argv[3]); return
    spec, out = json.load(open(sys.argv[2])), sys.argv[3]
    _, _, _, _, figs = figures(sheet)
    painted = {}
    for state, ids in spec['frames'].items():
        for dname, fid in zip(spec['dirs'], ids):
            img, ax, ay = frame(figs[fid], state)
            painted[f'{state}_{DIRS[dname]}'] = (img, ax, ay)
            if dname in MIRROR:
                painted[f'{state}_{DIRS[MIRROR[dname]]}'] = (img[:, ::-1].copy(), img.shape[1] - ax, ay)
    base = os.path.join(ROOT, 'build', 'soldier_blue')
    stand = painted['stand_0'][2]
    if spec.get('fit') == 'height':
        ref = load_atlas(base + '_hi')
        k0 = ref['stand_0'][2] / stand
        for n, (img, ax, ay) in list(painted.items()):
            if n.startswith('die_'):
                continue                                  # bodies on the ground keep their length
            painted[n] = scaled(img, ax, ay, ref[n][2] / (ay * k0))
    for suffix in ('', '_hi'):
        old = load_atlas(base + suffix)
        k = old['stand_0'][2] / stand
        for n, (img, ax, ay) in painted.items():
            old[n] = scaled(img, ax, ay, k)
        print(out + suffix, 'scale', round(k, 3), 'atlas', save_atlas(old, out + suffix)[:2])
    print(out + '_hi2', 'scale 1', 'atlas', save_atlas(painted, out + '_hi2')[:2], f'{len(painted)} painted frames')


if __name__ == '__main__':
    main()

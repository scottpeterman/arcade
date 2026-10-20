#!/usr/bin/env python3
"""Slice a soldier sprite sheet into an atlas + frame table for Normandy.

  python3 tools/slice_sprites.py SHEET.png OUT_PREFIX [--debug DEBUG.png] [--add NAME=PATH:WIDTH ...]

--add takes a single loose drawing on a white or transparent background (a body on
the ground, say), mattes it, scales it to WIDTH sheet pixels and adds it as frame NAME
plus a mirrored NAME_m. Anchor: centre of the bottom edge.

Writes OUT_PREFIX.png (packed atlas) and OUT_PREFIX.json (frame table).

The sheet layout is the one the generator produces: a header row of
direction labels (S SE E NE N NW W SW), a left column of state labels
(STAND WALK RUN AIM FIRE RELOAD GRENADE MELEE HIT DIE EXTRAS), one pose
per cell. Cells are not on a fixed grid, so cells are found as connected
components and assigned to the nearest label centre.

Red spatter (HIT/DIE) is removed so the game stays bloodless.
Each frame gets an anchor: x at the helmet, y at the feet.
"""
import sys, json
import numpy as np
from PIL import Image
from scipy import ndimage as nd

STATES = ['stand', 'walk', 'run', 'aim', 'fire', 'reload', 'grenade', 'melee', 'hit', 'die']
EXTRAS = ['kneel', 'mg_prone', 'rifle_prone', 'rifle_prone2', 'mg_bipod', 'bazooka', 'mortar', 'kneel2',
          'grenade_item', 'stick_item', 'pack_item', 'shovel_item', 'bag_item', 'helmet_item']
ALPHA = 128


def label_centres(m):
    lab, _ = nd.label(m[:, :140])
    rows = []
    for sl in nd.find_objects(lab):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if h > 15 and w > 40:
            rows.append(((sl[0].start + sl[0].stop) / 2, sl[1].stop))
    rows.sort()
    lab, _ = nd.label(m[:44, :])
    cols = []
    for sl in nd.find_objects(lab):
        if sl[1].stop - sl[1].start > 20:
            cols.append(((sl[1].start + sl[1].stop) / 2, sl[0].stop))
    cols.sort()
    return rows, cols


def debleed(a):
    """Drop blood-coloured pixels: strong red with low green and blue."""
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    blood = (r > 110) & (g < 75) & (b < 75) & (r > 2.0 * g + 20)
    a = a.copy()
    a[blood, 3] = 0
    return a


def helmet_x(cell, x0, y0):
    """Mean x of grey helmet pixels in the top quarter of the figure."""
    r, g, b, al = (cell[..., i].astype(int) for i in range(4))
    h = cell.shape[0]
    top = max(6, h // 4)
    grey = (al > ALPHA) & (abs(r - g) < 18) & (abs(g - b) < 22) & (r > 45) & (r < 170)
    ys, xs = np.nonzero(grey[:top])
    if len(xs) < 8:
        ys, xs = np.nonzero(al[:top] > ALPHA)
    return x0 + float(np.median(xs))


def main():
    sheet, out = sys.argv[1], sys.argv[2]
    dbg = sys.argv[sys.argv.index('--debug') + 1] if '--debug' in sys.argv else None
    a = np.array(Image.open(sheet).convert('RGBA'))
    m0 = a[..., 3] > ALPHA
    rows, cols = label_centres(m0)
    assert len(rows) == 11 and len(cols) == 8, (len(rows), len(cols))
    a = debleed(a)
    a[a[..., 3] <= ALPHA, 3] = 0
    a[..., 3] = np.where(a[..., 3] > 0, 255, 0)
    m = a[..., 3] > 0
    label_right = max(r[1] for r in rows) + 2
    header_bot = max(c[1] for c in cols) + 4
    m[:header_bot, :] = False
    for ry_, rx1 in rows:
        m[int(ry_ - 22):int(ry_ + 22), :rx1 + 3] = False
    m[:, :int(cols[0][0] - 95)] = False
    lab, n = nd.label(m, structure=np.ones((3, 3)))
    objs = nd.find_objects(lab)
    ry = np.array([r[0] for r in rows])
    cx = np.array([c[0] for c in cols])
    cells = {}
    extras = []
    for k, sl in enumerate(objs, 1):
        if sl is None:
            continue
        sz = int((lab[sl] == k).sum())
        if sz < 4:
            continue
        yc = (sl[0].start + sl[0].stop) / 2
        xc = (sl[1].start + sl[1].stop) / 2
        r = int(np.argmin(abs(ry - yc)))
        if r == 10:
            extras.append((k, sl, sz))
            continue
        c = int(np.argmin(abs(cx - xc)))
        cells.setdefault((r, c), []).append((k, sl, sz))
    # extras: cluster components left to right by x gaps
    extras.sort(key=lambda e: e[1][1].start)
    groups = []
    for e in extras:
        if groups and e[1][1].start <= max(g[1][1].stop for g in groups[-1]) + 4:
            groups[-1].append(e)
        else:
            groups.append([e])
    groups = [g for g in groups if sum(e[2] for e in g) > 150]

    frames = []

    def crop(group, name, state, dirn, anchor_mode):
        keep = np.zeros_like(m)
        y0 = min(e[1][0].start for e in group); y1 = max(e[1][0].stop for e in group)
        x0 = min(e[1][1].start for e in group); x1 = max(e[1][1].stop for e in group)
        for k, sl, _ in group:
            keep[sl] |= lab[sl] == k
        cell = a[y0:y1, x0:x1].copy()
        cell[~keep[y0:y1, x0:x1], 3] = 0
        body = max(group, key=lambda e: e[2])
        by1 = body[1][0].stop
        if anchor_mode == 'helmet':
            ax = helmet_x(cell, x0, y0)
        else:
            ax = (x0 + x1) / 2
        frames.append(dict(name=name, state=state, dir=dirn, img=cell, ax=ax - x0, ay=by1 - y0,
                           src=[x0, y0, x1 - x0, y1 - y0]))

    for (r, c), group in sorted(cells.items()):
        st = STATES[r]
        crop(group, f'{st}_{c}', st, c, 'centre' if st == 'die' else 'helmet')
    if '--extras' not in sys.argv:
        groups = []
    for i, g in enumerate(groups):
        nm = EXTRAS[i] if i < len(EXTRAS) else f'extra{i}'
        crop(g, nm, 'extra', i, 'centre')

    for i, arg in enumerate(sys.argv):
        if arg != '--add':
            continue
        name, rest = sys.argv[i + 1].split('=', 1)
        path, width = rest.rsplit(':', 1)
        im = np.array(Image.open(path).convert('RGBA')).astype(int)
        if im[..., 3].min() == 255:
            # white ground: anything clearly off-white is figure, then drop specks
            diff = 255 - im[..., :3].min(-1)
            rgb_ = im[..., :3]
            sat = rgb_.max(-1) - rgb_.min(-1)
            halo = (rgb_.mean(-1) > 110) & (sat < 34)          # light, grey: the soft fringe round the edge
            fig = (diff > 46) & ~halo
            fig = nd.binary_opening(fig, iterations=2)
            fig = nd.binary_fill_holes(fig)
            fig = nd.binary_erosion(fig, iterations=3)
            lab_, n_ = nd.label(fig)
            if n_:
                sizes = nd.sum(fig, lab_, range(1, n_ + 1))
                fig = np.isin(lab_, 1 + np.nonzero(sizes > sizes.max() * 0.02)[0])
            im[..., 3] = np.where(fig, 255, 0)
        im = debleed(im.astype(np.uint8))
        ys, xs = np.nonzero(im[..., 3] > ALPHA)
        im = im[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        k = int(width) / im.shape[1]
        nw, nh = int(width), max(1, round(im.shape[0] * k))
        pim = Image.fromarray(im)
        rgb = pim.convert('RGB').resize((nw, nh), Image.BOX)
        al = pim.getchannel('A').resize((nw, nh), Image.BOX)
        cell = np.dstack([np.array(rgb), (np.array(al) > ALPHA).astype(np.uint8) * 255])
        for nm, c_ in ((name, cell), (name + '_m', cell[:, ::-1].copy())):
            frames.append(dict(name=nm, state='extra', dir=99, img=c_, ax=nw / 2, ay=nh, src=[0, 0, nw, nh]))

    # crisp pass: the sheet is soft AI pixel art with no true grid. Box-filter each frame
    # down by PX, cut it to a small shared palette, and ring it with a dark outline, so it
    # renders as hard-edged pixels at any range. Anchors scale with it.
    PX = 2
    if '--soft' not in sys.argv:
        allpx = np.concatenate([f['img'][f['img'][..., 3] > 0][:, :3] for f in frames])
        flash = np.array([[255, 236, 120], [255, 196, 64], [255, 140, 30], [255, 252, 220]] * 4000, np.uint8)
        allpx = np.concatenate([allpx, flash])
        pal_img = Image.fromarray(allpx.reshape(1, -1, 3).astype(np.uint8)).quantize(colors=48, method=Image.Quantize.MEDIANCUT)
        for f in frames:
            im = f['img']
            h, w = im.shape[:2]
            nh, nw = max(1, (h + PX - 1) // PX), max(1, (w + PX - 1) // PX)
            pad = np.zeros((nh * PX, nw * PX, 4), np.float32)
            pad[:h, :w] = im
            blk = pad.reshape(nh, PX, nw, PX, 4)
            al = blk[..., 3].mean(axis=(1, 3))
            wsum = blk[..., 3].sum(axis=(1, 3))[..., None]
            rgb = (blk[..., :3] * blk[..., 3:4]).sum(axis=(1, 3)) / np.maximum(wsum, 1)
            keep = al >= 110
            q = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).quantize(palette=pal_img, dither=Image.Dither.NONE).convert('RGB')
            rgb = np.array(q)
            out_ = np.zeros((nh + 2, nw + 2, 4), np.uint8)
            out_[1:-1, 1:-1, :3] = rgb
            out_[1:-1, 1:-1, 3] = np.where(keep, 255, 0)
            m_ = out_[..., 3] > 0
            ring = np.zeros_like(m_)
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ring |= np.roll(np.roll(m_, dy, 0), dx, 1)
            ring &= ~m_
            out_[ring] = (20, 22, 26, 255)
            f['img'] = out_
            f['ax'] = f['ax'] / PX + 1
            f['ay'] = int(round(f['ay'] / PX)) + 1

    # pack: shelf packer, 1px gutter
    W = 1024
    frames.sort(key=lambda f: -f['img'].shape[0])
    x = y = sh = 0
    for f in frames:
        h, w = f['img'].shape[:2]
        if x + w + 1 > W:
            x = 0; y += sh + 1; sh = 0
        f['x'], f['y'] = x, y
        x += w + 1; sh = max(sh, h)
    H = y + sh
    atlas = np.zeros((H, W, 4), np.uint8)
    for f in frames:
        h, w = f['img'].shape[:2]
        atlas[f['y']:f['y'] + h, f['x']:f['x'] + w] = f['img']
    Image.fromarray(atlas).save(out + '.png', optimize=True)
    table = {f['name']: [f['x'], f['y'], f['img'].shape[1], f['img'].shape[0], round(f['ax'], 1), f['ay']]
             for f in frames}
    json.dump(table, open(out + '.json', 'w'), separators=(',', ':'))
    missing = [f'{s}_{c}' for s in STATES for c in range(8) if f'{s}_{c}' not in table]
    print(f'{len(frames)} frames, atlas {W}x{H}, missing: {missing or "none"}')
    if dbg:
        cw, ch = 150, 120
        D = Image.new('RGBA', (cw * 8, ch * 11), (40, 44, 52, 255))
        from PIL import ImageDraw
        d = ImageDraw.Draw(D)
        for f in frames:
            if f['state'] == 'extra':
                r, c = 10, f['dir'] % 8
                if f['dir'] >= 8:
                    continue
            else:
                r, c = STATES.index(f['state']), f['dir']
            ox, oy = c * cw + cw // 2, r * ch + ch - 14
            D.alpha_composite(Image.fromarray(f['img']), (int(ox - f['ax']), int(oy - f['ay'])))
            d.line([(ox - 20, oy), (ox + 20, oy)], fill=(255, 220, 0, 255))
            d.line([(ox, oy - 90), (ox, oy + 4)], fill=(255, 220, 0, 120))
        D.save(dbg)


if __name__ == '__main__':
    main()

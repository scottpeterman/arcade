#!/usr/bin/env python3
"""Make the in-hand M1 from a reference sheet.

  python3 tools/gun.py src/m1_ref.png build/gun.png

Takes the sheet's middle view (left side, muzzle left), drops the sling with a
hand-drawn line along the rifle's underside, and warps it in perspective into the
game's 120x70 rifle box at 8x: muzzle small near (35, 2), butt large past the
bottom-right corner, the same placement the drawn rifle used, so the muzzle flash
and bayonet still line up.
"""
import sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

K = 8                       # output scale over the 120x70 box
SRC_BOX = (12, 289, 1725, 583)
# underside of the rifle in the cropped view, muzzle to butt; everything below goes
UNDER = [(0, 116), (200, 116), (230, 100), (470, 136), (520, 132), (1120, 156), (1132, 200), (1228, 200),
         (1252, 162), (1290, 162), (1713, 296)]


def perspective(dst, src):
    """Coefficients for Image.transform(PERSPECTIVE): output point -> source point."""
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return np.linalg.solve(np.array(A, float), np.array(b, float))


def main():
    src, out = sys.argv[1], sys.argv[2]
    a = np.array(Image.open(src).convert('RGBA'))
    lab, _ = nd.label(a[..., 3] > 128)
    x0, y0, x1, y1 = SRC_BOX
    sub = a[y0:y1, x0:x1].copy()
    keep = lab[y0:y1, x0:x1] == lab[(y0 + y1) // 2, (x0 + x1) // 2]
    cut = Image.new('L', (x1 - x0, y1 - y0), 0)
    ImageDraw.Draw(cut).polygon(UNDER + [(x1 - x0, y1 - y0 + 5), (0, y1 - y0 + 5)], fill=255)
    keep &= np.array(cut) == 0
    sub[~keep, 3] = 0
    # what's left of the sling below the line: only the rifle's own blob survives
    lab2, n2 = nd.label(sub[..., 3] > 128)
    if n2 > 1:
        sizes = nd.sum(np.ones_like(lab2), lab2, range(1, n2 + 1))
        sub[lab2 != 1 + int(np.argmax(sizes)), 3] = 0
    rifle = Image.fromarray(sub)
    W, H = rifle.size
    # rifle axis in the box: muzzle at (33, 2), butt end at (140, 84), off the corner
    m, bt = np.array([33.0, 2.0]), np.array([140.0, 84.0])
    ax = (bt - m) / np.linalg.norm(bt - m)
    nrm = np.array([ax[1], -ax[0]])                                  # points up-right, the rifle's top side
    hm, hb = 10.0, 24.0                                              # rifle depth at muzzle and at butt
    top_m, bot_m = m + nrm * hm * 0.45, m - nrm * hm * 0.55
    top_b, bot_b = bt + nrm * hb * 0.45, bt - nrm * hb * 0.55
    dst = [tuple(p * K) for p in (top_m, top_b, bot_b, bot_m)]
    srcq = [(0, 0), (W, 0), (W, H), (0, H)]
    coef = perspective(dst, srcq)
    # supersample the warp, then box down, for clean edges
    ss = 2
    big = rifle.transform((120 * K * ss, 70 * K * ss), Image.PERSPECTIVE,
                          perspective([(x * ss, y * ss) for x, y in dst], srcq), Image.BICUBIC)
    img = big.resize((120 * K, 70 * K), Image.LANCZOS)
    # the sheet is studio-lit; take it down toward the overcast
    px = np.array(img).astype(np.float32)
    px[..., :3] *= np.array([0.86, 0.86, 0.88])
    Image.fromarray(np.clip(px, 0, 255).astype(np.uint8)).save(out, optimize=True)
    print(out, img.size)


if __name__ == '__main__':
    main()

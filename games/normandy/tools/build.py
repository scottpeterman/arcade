#!/usr/bin/env python3
"""Build Normandy's single-file index.html.

  git clone --depth 1 https://github.com/freedoom/freedoom.git
  python3 tools/slice_sprites.py src/1000011203.png build/soldier_blue --add down=src/down.png:150 --add fall=src/fall.png:150
  python3 tools/slice_sprites.py src/1000011203.png build/soldier_blue_hi --px 1 --add down=src/down.png:150 --add fall=src/fall.png:150
  python3 tools/build.py FREEDOOM_DIR

Reads game.html, replaces the /*@ASSETS@*/ marker with the texture and sprite
data URIs, writes index.html. Needs Pillow and numpy.

Textures come from Freedoom (BSD licence) and are retinted for an overcast
June morning on the Channel coast. Every texture is a power of two on both
sides, which the rasterizer's wrap masks depend on.
"""
import sys, os, io, re, json, base64
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load_defs(root):
    defs = {}; cur = None
    for line in open(os.path.join(root, 'lumps/textures/textures.cfg')):
        line = line.split(';')[0].rstrip()
        if not line.strip() or line.startswith('#'):
            continue
        m = re.match(r'^(\S+)\s+(\d+)\s+(\d+)', line)
        if m and not line.startswith('*'):
            name = m.group(1).upper(); cur = None
            if name not in defs:
                cur = defs[name] = {'w': int(m.group(2)), 'h': int(m.group(3)), 'p': []}
            continue
        m = re.match(r'^\*\s+(\S+)\s+(-?\d+)\s+(-?\d+)', line)
        if m and cur is not None:
            cur['p'].append((m.group(1).lower(), int(m.group(2)), int(m.group(3))))
    return defs


def compose(root, defs, name):
    d = defs[name]; im = Image.new('RGBA', (d['w'], d['h']), (0, 0, 0, 0))
    for p, x, y in d['p']:
        f = os.path.join(root, 'patches', p + '.png')
        if not os.path.exists(f):
            continue
        pi = Image.open(f).convert('RGBA')
        if x >= 0 and y >= 0:
            im.alpha_composite(pi, (x, y))
        else:
            im.paste(pi, (x, y), pi)
    return im


def flat(root, name):
    return Image.open(os.path.join(root, 'flats', name + '.png')).convert('RGBA')


def ramp(im, lo, hi, contrast=1.0):
    """Map luminance onto a two-colour ramp."""
    a = np.asarray(im.convert('RGB'), dtype=np.float32) / 255
    l = a @ np.array([0.299, 0.587, 0.114], np.float32)
    l = (l - l.mean()) * contrast + 0.5
    l = np.clip(l, 0, 1)[..., None]
    lo, hi = np.array(lo, np.float32), np.array(hi, np.float32)
    return Image.fromarray(np.clip(lo + (hi - lo) * l, 0, 255).astype(np.uint8), 'RGB')


def grade(im, sat=1.0, mul=(1, 1, 1), add=(0, 0, 0)):
    a = np.asarray(im.convert('RGB'), dtype=np.float32)
    g = a @ np.array([0.299, 0.587, 0.114], np.float32)
    a = g[..., None] + (a - g[..., None]) * sat
    a = a * np.array(mul, np.float32) + np.array(add, np.float32)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGB')


def uri(im, fmt='PNG'):
    b = io.BytesIO()
    if fmt == 'WEBP':
        im.save(b, fmt, quality=88, method=6)
    else:
        im.save(b, fmt, optimize=True)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(b.getvalue()).decode()


UP = 4   # texture upscale: the game samples UP texels per base texel (NM_TEXUP)


def upscale(im, k):
    """Tile-safe upscale: wrap-pad, Lanczos, crop, light unsharp. The seams still meet,
    so the wrap masks hold."""
    from PIL import ImageFilter
    a = np.asarray(im.convert('RGB'))
    h, w = a.shape[:2]
    p = 8
    big = Image.fromarray(np.pad(a, ((p, p), (p, p), (0, 0)), mode='wrap'))
    big = big.resize(((w + 2 * p) * k, (h + 2 * p) * k), Image.LANCZOS)
    big = big.crop((p * k, p * k, (p + w) * k, (p + h) * k))
    return big.filter(ImageFilter.UnsharpMask(radius=1.2 * k / 2, percent=60, threshold=2))


def textures(fd):
    D = load_defs(fd)
    W = lambda n: compose(fd, D, n)
    t = {}
    t['sand'] = ramp(flat(fd, 'floor7_1'), (150, 128, 88), (226, 204, 154), 2.6)
    t['wetsand'] = ramp(flat(fd, 'floor7_1'), (84, 76, 60), (146, 132, 100), 2.4)
    t['shingle'] = ramp(flat(fd, 'flat5_7'), (70, 66, 60), (190, 182, 166), 1.15)
    t['grass'] = grade(flat(fd, 'rrock20'), 0.7, (0.92, 0.95, 0.85))
    t['turf'] = grade(flat(fd, 'rrock20'), 0.55, (1.0, 0.94, 0.74))
    t['roof'] = grade(flat(fd, 'flat19'), 0.6, (0.98, 0.97, 0.93))
    t['deck'] = grade(flat(fd, 'floor4_1'), 0.35, (0.8, 0.86, 0.78))
    for i in range(4):
        t[f'water{i}'] = ramp(flat(fd, f'fwater{i + 1}'), (22, 38, 44), (104, 132, 128), 1.25)
    t['bunker'] = grade(W('CEMENT7'), 0.55, (1.0, 0.98, 0.93))
    t['seawall'] = grade(W('GRAY1'), 0.7, (0.98, 0.96, 0.9))
    t['steel'] = grade(W('SUPPORT3'), 0.6, (1.05, 1.0, 0.95))
    t['hull'] = ramp(W('GRAY5'), (52, 62, 54), (138, 150, 132), 1.1)
    t['ramp'] = ramp(W('GRAY4'), (58, 66, 58), (150, 158, 140), 1.1)
    t['timber'] = grade(W('WOOD9'), 0.7, (0.9, 0.85, 0.8))
    t['sky'] = grade(W('SKY1'), 0.55, (0.95, 0.98, 1.04))
    # D-1: the paved road, the bluff faces, the wooded sides, the villas and Vierville's stone
    t['road'] = ramp(flat(fd, 'flat5_4'), (54, 54, 52), (122, 120, 114), 1.6)
    t['rock'] = ramp(W('ROCK5'), (72, 68, 58), (158, 150, 132), 1.15)
    t['meadow'] = grade(flat(fd, 'grass1'), 0.8, (1.0, 1.0, 0.86))
    t['leaves'] = grade(W('ZIMMER1'), 0.75, (0.8, 0.95, 0.72))
    t['stucco'] = grade(W('STUCCO2'), 0.45, (1.12, 1.1, 1.04), (18, 18, 16))
    t['stone'] = grade(W('STONEW1'), 0.5, (0.98, 0.96, 0.92))
    t['crate'] = grade(W('CRATE1'), 0.8, (0.95, 0.9, 0.8))
    for k, v in t.items():
        w, h = v.size
        assert w & (w - 1) == 0 and h & (h - 1) == 0, (k, v.size)
    if UP > 1:
        t = {k: upscale(v, UP) for k, v in t.items()}
    return {k: uri(v.convert('RGB'), 'WEBP') for k, v in t.items()}


def sprites(prefix):
    table = json.load(open(prefix + '.json'))
    keep = {k: v for k, v in table.items() if re.match(r'^[a-z]+_\d$', k) or re.match(r'^(down|fall)(_m)?$', k)}
    out = {'img': uri(Image.open(prefix + '.png')), 'f': keep}
    if os.path.exists(prefix + '_hi.png'):
        hi = json.load(open(prefix + '_hi.json'))
        out['hi'] = {'img': uri(Image.open(prefix + '_hi.png')),
                     'f': {k: v for k, v in hi.items() if k in keep}}
    return out


def main():
    fd = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..', 'freedoom')
    tex = textures(fd)
    spr = sprites(os.path.join(ROOT, 'build', 'soldier_blue'))
    assets = ('const NM_TEX = ' + json.dumps(tex) + ';\nconst NM_TEXUP = ' + json.dumps({k: UP for k in tex}) +
              ';\nconst NM_SPR = ' + json.dumps(spr) + ';')
    src = open(os.path.join(ROOT, 'game.html')).read()
    assert '/*@ASSETS@*/' in src
    zz = open(os.path.join(ROOT, 'zzfx.js')).read()
    assert '/*@ZZFX@*/' in src
    frag = src.replace('/*@ASSETS@*/', assets).replace('/*@ZZFX@*/', zz)
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    open(os.path.join(ROOT, 'dist', 'artifact.html'), 'w').write(frag)
    full = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' + frag + '\n</html>\n')
    open(os.path.join(ROOT, 'dist', 'index.html'), 'w').write(full)
    # the playable page also sits at the game root, where the arcade menu links and
    # where a repo-wide 'dist' ignore rule can't drop it
    open(os.path.join(ROOT, 'index.html'), 'w').write(full)
    print(f'dist/index.html {len(full) / 1024:.0f} KB, {len(tex)} textures x{UP}, {len(spr["f"])} sprite frames'
          + (' + full-res set' if 'hi' in spr else ''))


if __name__ == '__main__':
    main()
